<script lang="ts">
  import { onMount } from "svelte";
  import { SvelteSet } from "svelte/reactivity";
  import {
    pf1eAttackRollGroups,
    pf1eManyshotRollSpecs,
    pf1eManyshotFullAttackRollSpecs,
    pf1eInitiativeRollSpec,
    pf1eSaveRollSpecs,
    type PF1eRollSpec,
  } from "../../packages/pf1e/rollData";
  import type { ClientSync, ClientEvents } from "../../client/sync";
  import type { EventBus } from "../../core/events";
  import PF1eAcConversion from "./PF1eAcConversion.svelte";
  import { previewAcConversion, type AcRequest } from "./pf1eAcConversion";
  import PF1eAttackEditor from "./PF1eAttackEditor.svelte";
  import { pf1eAttackEdit, type AttackEdit } from "./pf1eAttackEditor";
  import PF1eDetailsEditor from "./PF1eDetailsEditor.svelte";
  import PF1eEffectsTab from "./PF1eEffectsTab.svelte";
  import { can } from "../../core/permissions";
  import {
    SHEET_FIELDS,
    isPF1eActor,
    linkedCombatantId,
    sheetRecord,
    pf1eDetailEdit,
    type DetailEdit,
    authoredNumber,
    pf1eSheetEdit,
    pf1eSheetView,
    pf1eSpellSlotReadout,
    type SheetField,
  } from "./pf1eSheetModel";
  import {
    pf1eSpellbookEdit,
    pf1eSpellbookView,
    type PF1eSpellbookEdit,
  } from "./pf1eSpellbook";
  import {
    resolveCastFlow,
    resolveChargeAllyTouches,
    resolveChargeWeaponRelease,
    resolvePendingCompletion,
    resolvePendingDisruption,
    resolveTouchDelivery,
    type PF1eCastFlowParams,
    type PF1eConcentrationDeclaration,
  } from "./pf1eCastFlow";
  import {
    heldChargeCount,
    heldChargeDiff,
    heldChargeFromSystem,
  } from "../../packages/pf1e/touchSpell";
  import {
    pendingCastDiff,
    pendingCastFromSystem,
  } from "../../packages/pf1e/pendingCast";
  import type {
    PF1eSaveSeverity,
    PF1eSaveType,
  } from "../../packages/pf1e/casting";
  import type { PF1eCastingTime } from "../../packages/pf1e/concentration";
  import type { PF1eEnergyType } from "../../packages/pf1e/healthState";
  import {
    pf1eApplyActorEffect,
    pf1eApplyCombatantEffect,
    pf1eEditActorEffect,
    pf1eEditCombatantEffect,
    pf1eRemoveActorEffect,
    pf1eRemoveCombatantEffect,
    pf1eSetActorEffectDisabled,
    pf1eSetCombatantEffectDisabled,
  } from "../../packages/pf1e/effectOps";
  import { resolveTacticalEffects } from "../../packages/pf1e/effectOps";
  import {
    mountedHigherGround,
    mountedRangedPenalty,
    mountedMeleeFullAttack,
    mountedCastingConcentrationDC,
    mountLinkageOf,
    guideWithKnees,
    stayInSaddle,
    unconsciousRiderStays,
    untrainedMountControl,
    lanceChargeMultiplier,
    mountFootprint,
    type PF1eMountMovement,
  } from "../../packages/pf1e/mounted";
  import { firearmShotAmmo, FIREARM_EXPLOSION_DC, FIREARM_EXPLOSION_RADIUS_FT, firearmExplosionSquares, quickClearReloadCost, firearmReloadEntry } from "../../packages/pf1e/firearms";
  import type {
    ActorDocument,
    CombatDocument,
    CombatantDocument,
    SceneDocument,
  } from "../../core/documents";
  import { resolveAttackFlow, resolveManyshotFlow, resolveFirearmExplosionFlow } from "./pf1eResolveFlow";
  import { resolveManeuverFlow } from "../combat/pf1eManeuverFlow";
  import { resolveAidAnotherFlow, resolveFeintFlow } from "../combat/pf1eAidFeintFlow";
  import type { PF1eDefenseChoice } from "../../packages/pf1e/resolve";
  import {
    COVER_GRADE_OPTIONS,
    activeSceneOf,
    pf1eResolvePositionReport,
    resolvePositionHint,
  } from "./pf1eResolvePosition";
  import { DEFAULT_SCENE_ID } from "../../app/hostBoot";
  import { validatePF1eFeatSelection } from "../../packages/pf1e/feats";
  import { autoResolveAoosOf } from "../../packages/pf1e/aooSettings";
  import { worldSettingsFrom } from "../../core/worldSettings";
  import {
    castProvokes,
    rangedAttackProvokes,
    resolveActionProvokes,
  } from "../combat/pf1eActionProvoke";
  import { planRest, restLevelOf } from "../combat/pf1eRest";
  import { applyHealing } from "../../packages/pf1e/healing";
  import { grantTempHp, expireTempHpSource } from "../../packages/pf1e/tempHp";
  import { energyDrainSaveDC, negativeLevelPenalties, negativeLevelTotalsOf } from "../../packages/pf1e/negativeLevels";
  import { planEnergyDrainInflict, planNegativeLevelSave, planRestoration } from "../combat/pf1eEnergyDrain";
  type TabName =
    | "summary"
    | "attributes"
    | "combat"
    | "weapons"
    | "armor"
    | "features"
    | "spells"
    | "effects"
    | "monster"
    | "details";

  let {
    doc,
    client,
    bus,
    initialTab = "summary",
  }: {
    doc: ActorDocument;
    client: ClientSync;
    bus: EventBus<ClientEvents>;
    /** E02: token-menu "Apply effect…" opens the sheet directly on this tab. */
    initialTab?: TabName;
  } = $props();
  let tab = $derived(initialTab);
  let error = $state("");
  const pending = new SvelteSet<string>();
  // E01: when this actor fights inside an encounter, its combatant's timed
  // effects (`flags.core.effects`) ride the derivation (id collision → the
  // ticking combatant copy wins).
  let linked = $derived(
    linkedCombatantId(
      doc._id,
      client.store.getAll("combats") as readonly CombatDocument[],
    ),
  );
  // The provoking action's scene token: this actor's combatant, when it fights inside an
  // encounter (D-191's cast path and D-192's ranged path both read it).
  function provokerTokenId(): string | null {
    const combatant =
      linked.combat !== null && linked.combatantId !== null
        ? (linked.combat.combatants.find(
            (c) => c._id === linked.combatantId,
          ) ?? null)
        : null;
    return combatant?.tokenId ?? null;
  }
  let view = $derived(
    pf1eSheetView(doc, {
      combat: linked.combat,
      combatantId: linked.combatantId,
    }),
  );
  let d = $derived(view.derived);
  let slotReadout = $derived(
    pf1eSpellSlotReadout(d, sheetRecord(view.authored.spells)),
  );
  // P5/C04 (D-155): persisted slot ledger + prepared list, spend/prepare Ops.
  let spellbook = $derived(pf1eSpellbookView(doc, d));
  let spellbookWarning = $state("");
  let negativeLevelsTotals = $derived(negativeLevelTotalsOf((doc.system as { pf1e?: { negativeLevels?: unknown } }).pf1e?.negativeLevels));
  let negativeLevelsPen = $derived(negativeLevelPenalties(negativeLevelsTotals.total));
  let negativeLevelsHd = $derived((() => { const raw = (doc.system as { pf1e?: { hitDice?: unknown } }).pf1e?.hitDice; return typeof raw === "number" && Number.isFinite(raw) ? Math.trunc(raw as number) : 0; })());
  // P5/C03 (D-158): a held touch-spell charge lives on the actor document.
  let heldCharge = $derived(
    heldChargeFromSystem(doc.system as Record<string, unknown>),
  );
  // P5/C03 (D-161): a multi-round casting begun but not yet completed.
  let pendingCast = $derived(
    pendingCastFromSystem(doc.system as Record<string, unknown>),
  );
  let pendingDisruptDamage = $state("");
  // D-206 — natural recovery (H03, AoN 170): level per night, 2× bed rest, long-term care.
  let restBed = $state(false);
  let restCare = $state(false);
  let restLevelOverride = $state("");
  let restNote = $state("");
  // P7/H02 — magical healing (CRB p.191): heals HP + equal nonlethal, never temp HP.
  let healAmountRaw = $state("");
  let healNote = $state("");
  // P7/H02 — temporary HP grant/expire (Paizo FAQ, CRB p.208).
  let tempHpSourceId = $state("");
  let tempHpAmountRaw = $state("");
  let tempHpExpireId = $state("");
  let tempHpNote = $state("");
  // P7/H04 — negative levels (AoN 427): infliction, 24h saves, restoration.
  let negativeLevelsCountRaw = $state("");
  let negativeLevelsKind = $state<"temporary" | "permanent">("temporary");
  let negativeLevelSaveKind = $state<"temporary" | "energy-drain">("temporary");
  let negativeLevelDieRaw = $state("");
  let negativeLevelFortRaw = $state("");
  let negativeLevelDcRaw = $state("");
  let restorationCountRaw = $state("");
  let restorationKind = $state<"any" | "temporary" | "permanent">("any");
  let negativeLevelsNote = $state("");
  let prepareName = $state("");
  let prepareLevel = $state("1");
  let prepareSlotLevel = $state("");
  let prepareComponents = $state("");
  // P5/C02 (D-156): the tactical cast panel's state.
  let castTargetId = $state("");
  let castName = $state("");
  let castLevel = $state("1");
  let castSlot = $state("");
  let castPreparedIndex = $state<number | null>(null);
  let castSaveType = $state<PF1eSaveType>("ref");
  let castSeverity = $state<PF1eSaveSeverity>("half");
  let castDamage = $state("");
  let castEnergy = $state("");
  let castSrOvercome = $state(false);
  // Touch delivery (D-158): "", "melee" or "ranged".
  let castTouch = $state("");
  // D-159: the GM declares the target willing — the touch is automatic.
  let castWilling = $state(false);
  // D-162: charges for a multi-touch spell (Chill Touch holds one per level).
  let castCharges = $state("1");
  // D-163: the GM declares the spell quickened — it rides the swift action.
  let castQuickened = $state(false);
  // D-162: allies picked for the full-round willing-ally touch.
  let allyTouchPicks = $state<Record<string, boolean>>({});
  // D-162: the authored attack line a held charge is released through.
  let releaseAttackIndex = $state(0);
  // C03a gate (D-157): components line + the GM-declared situation.
  let castComponents = $state("");
  let castTime = $state("standard");
  let castCannotSpeak = $state(false);
  let castNoFreeHand = $state(false);
  let castNoComponentsInHand = $state(false);
  let castDeafened = $state(false);
  let castGrappled = $state(false);
  let castPinned = $state(false);
  let castDefensively = $state(false);
  let castInjured = $state(false);
  let castInjuredDamage = $state("");
  // D-160: the remaining Table 9-1 concentration situations (GM declares).
  let castMotion = $state("");
  let castWeather = $state("");
  let castEntangled = $state(false);
  let castContinuous = $state(false);
  let castContinuousAmount = $state("");
  let castNonDamaging = $state(false);
  let castNonDamagingDc = $state("");
  let castGrappleCheck = $state(false);
  let castGrappleCmb = $state("");
  let castMountMovedBeforeAndAfter = $state(false);
  let castMountRunning = $state(false);
  let castBusy = $state(false);
  let castError = $state("");
  let castWarning = $state("");
  let resolvedEffects = $derived(resolveTacticalEffects(view.effects));
  let effectBoosts = $derived(
    resolvedEffects.boosts.map((boost, i) => ({
      boost,
      from: resolvedEffects.boostSources[i] ?? "effect",
    })),
  );
  let featWarnings = $derived(
    validatePF1eFeatSelection(
      Array.isArray(view.authored.feats) ? view.authored.feats : [],
      {
        bab: view.authored.baseAttack,
        abilities: view.authored.abilities,
      },
    ),
  );
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
      effectBoosts,
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
  function manyshotRolls(index: number): PF1eRollSpec[] {
    return pf1eManyshotRollSpecs(
      d,
      index,
      Array.isArray(view.authored.feats) ? view.authored.feats : [],
    );
  }
  /**
   * The Manyshot-aware full-attack rolls for one line: when Manyshot applies,
   * the volley **is** the first iterative (2–4 arrows at the first bonus −4)
   * and remaining iteratives follow as single arrows, so the first bonus is
   * not doubled. When Manyshot does not apply this is exactly the ladder.
   */
  function manyshotFullAttackRolls(index: number): PF1eRollSpec[] {
    return pf1eManyshotFullAttackRollSpecs(
      d,
      index,
      Array.isArray(view.authored.feats) ? view.authored.feats : [],
    );
  }

  // A06b — resolve one attack against a target actor: public rolls, the
  // resolution card, and HP writes through the sheet's own op path.
  let resolveTargetId = $state("");
  let resolveAttackIndex = $state(0);
  let resolveDefense = $state<PF1eDefenseChoice>("normal");
  // P02/D-197 — position-aware resolve: flanking and cover read off the linked
  // tokens and the scene walls when "auto" (the pair seam's own word), or are
  // set by hand when the table overrules the geometry.
  let resolveFlankingMode = $state<"auto" | "yes" | "no">("auto");
  let resolveCoverMode = $state<
    "auto" | "none" | (typeof COVER_GRADE_OPTIONS)[number]
  >("auto");
  let resolveCharging = $state(false);
  let resolveMountMovement = $state<PF1eMountMovement>("stationary");
  let resolveMountMovedFtRaw = $state("");
  let resolveNonlethal = $state(false);
  let resolveVerifiable = $state(false);
  let resolvePowerAttack = $state(false);
  let resolveDeadlyAim = $state(false);
  let resolveCombatExpertise = $state(false);
  let resolveFightingDefensively = $state(false);
  let resolvePointBlank = $state(false);
  let resolveBusy = $state(false);
  let manyshotBusy = $state(false);
  let resolveError = $state("");
  let resolveWarning = $state("");
  // P05/D-210 — maneuver resolution (CombatPanel and the sheet share the same flow)
  let maneuverKind = $state("trip");
  let maneuverTargetId = $state("");
  let maneuverHasImproved = $state(false);
  let maneuverBusy = $state(false);
  let maneuverError = $state("");
  let maneuverWarning = $state("");
  let maneuverVerifiable = $state(false);
  // P05/D-211 — Aid Another and Feint (the two A.9 companions, separate from the ten maneuvers)
  let aidAidedId = $state("");
  let aidOpponentId = $state("");
  let aidChoice = $state<"attack" | "ac">("attack");
  let aidAidedProvokes = $state(false);
  let aidVerifiable = $state(false);
  let aidBusy = $state(false);
  let aidError = $state("");
  let aidWarning = $state("");
  let feintTargetId = $state("");
  let feintBluffBonusRaw = $state("");
  let feintHasImproved = $state(false);
  let feintHasGreater = $state(false);
  let feintBusy = $state(false);
  let feintError = $state("");
  let feintWarning = $state("");
  let feintVerifiable = $state(false);
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

  // P02 — the pair's positional facts, read off the active scene the same way
  // App.svelte reads it. Recomputed whenever the target, the attack line, the
  // scene or its tokens change; every unreadable state is named in the hint.
  let resolvePosition = $derived(
    pf1eResolvePositionReport({
      scene: activeSceneOf(
        client.store.getAll("scenes") as readonly SceneDocument[],
        DEFAULT_SCENE_ID,
      ),
      actors: client.store.getAll("actors") as readonly ActorDocument[],
      attackerActorId: doc._id,
      targetActorId: resolveTargetId,
      ranged: (d.attacks[resolveAttackIndex]?.ranged ?? false) === true,
      ...(d.attacks[resolveAttackIndex] !== undefined
        ? { reachSquares: d.attacks[resolveAttackIndex]?.reachSquares }
        : {}),
    }),
  );
  let resolvePositionLine = $derived(
    resolvePositionHint(resolvePosition, {
      attacker: doc.name,
      target: resolveTargetInfo()?.actor.name ?? "the target",
    }),
  );
  /** The flanking fact the flow folds in: auto = the scene's word (melee only). */
  let effectiveFlanking = $derived(
    resolveFlankingMode === "yes"
      ? true
      : resolveFlankingMode === "no"
        ? false
        : resolvePosition.ok &&
          resolvePosition.flanked &&
          (d.attacks[resolveAttackIndex]?.ranged ?? false) === false,
  );
  /** P08/D-201 — the authored linkage, re-read from the live document. */
  let currentMount = $derived(
    mountLinkageOf(
      (doc.system as { pf1e?: { mount?: unknown } }).pf1e?.mount,
    ),
  );

  /** P08/D-201 — write the whole linkage triple; one edit per change. */
  function updateMount(
    actorId: string | null,
    combatTrained: boolean,
    saddle: "none" | "military",
  ): void {
    updateDetail({ kind: "mount", actorId, combatTrained, saddle });
  }

  // P08/D-217 — Ride check state (raw inputs, notes, falling 1d6)
  let rideBonusRaw = $state("");
  let rideDieRaw = $state("");
  let rideD100Raw = $state("");
  let rideNote = $state("");
  let rideError = $state("");
  let rideFallingNote = $state("");
  let rideBusy = $state(false);
  // P09/D-218 — grit and firearm UI state (Quick Clear, Expert Loading; UC p.135)
  let gritCurrentRaw = $state("");
  let gritMaxRaw = $state("");
  let gritNote = $state("");
  let firearmError = $state("");
  let firearmNote = $state("");
  let firearmBusy = $state(false);
  let spendGritForClear = $state(false);
  let resolveExpertLoading = $state(false);
  // P09/D-219 — explosion burst placement & per-target Reflex (UC p.135, 5-ft burst from a chosen corner)
  let explosionCornerColRaw = $state("0");
  let explosionCornerRowRaw = $state("0");
  let explosionDamageRaw = $state("");
  let explosionBusy = $state(false);
  let explosionError = $state("");
  let explosionNote = $state("");
  let explosionTargetPicks = $state<Record<string, boolean>>({});

  // P08/D-217 — Ride checks (A.11): DC 20 untrained control, DC 5 knees, DC 15 stay, 50/75% unconscious; fall ⇒ 1d6
  function parseRideBonus(): number {
    const raw = rideBonusRaw.trim();
    if (raw === "") return d.abilityMods.dex;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) ? n : d.abilityMods.dex;
  }
  function parseRideDie(): number | null {
    const n = Number.parseInt(rideDieRaw.trim(), 10);
    if (!Number.isInteger(n) || n < 1 || n > 20) return null;
    return n;
  }
  async function applyFallingDamage(notePrefix: string): Promise<void> {
    const current = client.store.get("actors", doc._id) as ActorDocument | undefined;
    if (!current || !client.user || !can(client.user, "update", current, "actors")) {
      rideFallingNote = `${notePrefix} — no permission to apply 1d6 (apply manually)`;
      return;
    }
    rideBusy = true;
    try {
      const rollId = client.roll("1d6", "roll", undefined, "falling from mount 1d6 (A.11)");
      // Wait for the host-evaluated roll message
      const deadline = Date.now() + 10000;
      let total: number | null = null;
      for (;;) {
        for (const msg of client.store.getAll("messages") as readonly { flags?: { core?: { rollId?: unknown } }; roll?: { total?: unknown } }[]) {
          if ((msg.flags as { core?: { rollId?: unknown } })?.core?.rollId === rollId && typeof msg.roll?.total === "number") {
            total = msg.roll.total as number;
            break;
          }
        }
        if (total !== null) break;
        if (Date.now() >= deadline) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      if (total === null) {
        rideFallingNote = `${notePrefix} — falling roll did not arrive (apply 1d6 manually)`;
        return;
      }
      const derived = pf1eSheetView(current).derived;
      const after = derived.hp - total;
      const edit = pf1eSheetEdit(current, client.user, "hp", String(after));
      if (edit.error) rideFallingNote = `${notePrefix} — 1d6 = ${total} but HP write rejected: ${edit.error}`;
      else {
        if (edit.ops.length) pending.add(client.submit(edit.ops));
        rideFallingNote = `${notePrefix} — 1d6 = ${total} applied (${derived.hp} → ${after} HP)`;
      }
    } finally {
      rideBusy = false;
    }
  }
  function doRideCheck(kind: "control" | "knees" | "stay"): void {
    rideError = "";
    rideNote = "";
    rideFallingNote = "";
    const bonus = parseRideBonus();
    const die = parseRideDie();
    if (die === null) {
      rideError = "Ride d20 must be 1–20";
      return;
    }
    if (kind === "control") {
      const v = untrainedMountControl({ die, rideMod: bonus });
      rideNote = `d20 ${die} + ${bonus} = ${die + bonus} vs DC 20 — ${v.reason}`;
      if (!v.controlled) rideNote += " · the move becomes a full-round action";
    } else if (kind === "knees") {
      const v = guideWithKnees({ die, rideMod: bonus });
      rideNote = `d20 ${die} + ${bonus} = ${die + bonus} vs DC 5 — ${v.reason}`;
    } else {
      const v = stayInSaddle({ die, rideMod: bonus });
      rideNote = `d20 ${die} + ${bonus} = ${die + bonus} vs DC 15 — ${v.reason}`;
      if (!v.stays) void applyFallingDamage("Fell from mount (DC 15 failed)");
    }
  }
  function doUnconsciousCheck(): void {
    rideError = "";
    rideNote = "";
    rideFallingNote = "";
    const raw = rideD100Raw.trim();
    const roll = Number.parseInt(raw, 10);
    if (!Number.isInteger(roll) || roll < 1 || roll > 100) {
      rideError = "Unconscious check d100 must be 1–100";
      return;
    }
    const saddle = currentMount?.saddle ?? "none";
    const v = unconsciousRiderStays({ saddle, roll });
    rideNote = `d100 ${roll} vs ${saddle === "military" ? 75 : 50}% — ${v.reason}`;
    if (!v.stays) void applyFallingDamage("Fell while unconscious");
  }
  function doGritUpdate(): void {
    gritNote = "";
    error = "";
    const cur = gritCurrentRaw.trim();
    const max = gritMaxRaw.trim();
    if (cur !== "") {
      const r = pf1eSheetEdit(doc, client.user, "grit.current", cur);
      if (r.error) { error = r.error; return; }
      if (r.ops.length) pending.add(client.submit(r.ops));
    }
    if (max !== "") {
      const r = pf1eSheetEdit(doc, client.user, "grit.max", max);
      if (r.error) { error = r.error; return; }
      if (r.ops.length) pending.add(client.submit(r.ops));
    }
    gritNote = `grit ${d.grit.current}/${d.grit.max} — updated`;
    gritCurrentRaw = "";
    gritMaxRaw = "";
  }
  async function doFirearmReload(): Promise<void> {
    firearmError = ""; firearmNote = "";
    const current = client.store.get("actors", doc._id) as ActorDocument | undefined;
    if (!current) { firearmError = "Actor is no longer available."; return; }
    const line = d.attacks[resolveAttackIndex];
    if (!line) { firearmError = "Pick an attack line first."; return; }
    if (line.misfire === undefined) { firearmError = "This line is not a firearm (add firearm generation / misfire)."; return; }
    if (!client.user || !can(client.user, "update", current, "actors")) { firearmError = "You do not own this actor."; return; }
    if (line.ammo && line.ammo.loaded >= line.ammo.capacity) { firearmNote = "Already fully loaded."; return; }
    if (line.misfire.broken) { firearmError = "The firearm is broken — clear the jam first (Quick Clear)."; return; }
    firearmBusy = true;
    try {
      const tokenId = provokerTokenId();
      if (tokenId !== null) {
        const provoke = await resolveActionProvokes({
          client,
          user: client.user,
          provokerTokenId: tokenId,
          provokes: [{ actionId: "load-firearm" }],
          autoResolve: autoResolveAoosOf(worldSettingsFrom(client.store.getAll("settings"))),
          combat: linked.combat,
        });
        if (provoke.lines.length > 0) firearmNote = provoke.lines.join(" · ");
      }
      const capacity = line.ammo?.capacity ?? 1;
      const diff: Record<string, import("../../core/documents").Json> = {};
      diff[`system.pf1e.attacks.${resolveAttackIndex}.firearm.loaded`] = capacity as unknown as import("../../core/documents").Json;
      pending.add(client.submit([{ kind: "update", ref: { coll: "actors", id: current._id }, diff }]));
      firearmNote = firearmNote ? `${firearmNote} · Reloaded ${line.name} to ${capacity}/${capacity} — ${reloadEntry ? `${reloadEntry.category} action, provokes ${reloadEntry.provokes}` : "move action, provokes"} (UC p.135 §2.9).` : `Reloaded ${line.name} to ${capacity}/${capacity} — ${reloadEntry ? `${reloadEntry.category} action, provokes ${reloadEntry.provokes}` : "move action, provokes"} (UC p.135 §2.9).`;
      // The rejected attack's premise (0 loaded) no longer holds — clear the
      // stale refusal so the resolve panel doesn't contradict the 1/1 read-out.
      resolveError = "";
    } finally { firearmBusy = false; }
  }
  async function doFirearmClear(): Promise<void> {
    firearmError = ""; firearmNote = "";
    const current = client.store.get("actors", doc._id) as ActorDocument | undefined;
    if (!current) { firearmError = "Actor is no longer available."; return; }
    const line = d.attacks[resolveAttackIndex];
    if (!line) { firearmError = "Pick an attack line first."; return; }
    if (line.misfire === undefined) { firearmError = "Not a firearm."; return; }
    if (!line.misfire.broken) { firearmNote = "Not broken — nothing to clear."; return; }
    if (!client.user || !can(client.user, "update", current, "actors")) { firearmError = "You do not own this actor."; return; }
    const cost = quickClearReloadCost({ gritAvailable: d.grit.current, spendGrit: spendGritForClear });
    if (cost.refusal) { firearmError = cost.refusal; return; }
    firearmBusy = true;
    try {
      const ops: import("../../core/ops").Op[] = [];
      ops.push({ kind: "update", ref: { coll: "actors", id: current._id }, diff: { [`system.pf1e.attacks.${resolveAttackIndex}.broken`]: false as unknown as import("../../core/documents").Json } });
      if (cost.gritSpent === 1) {
        const next = Math.max(0, d.grit.current - 1);
        ops.push({ kind: "update", ref: { coll: "actors", id: current._id }, diff: { "system.pf1e.grit.current": next as unknown as import("../../core/documents").Json } });
      }
      pending.add(client.submit(ops));
      firearmNote = `Cleared jam on ${line.name} — ${cost.cost} (${cost.gritSpent ? "spent 1 grit, Quick Clear" : "standard action"}).`;
    } finally { firearmBusy = false; }
  }
  function firearmExplosionHint(): string | null {
    const line = d.attacks[resolveAttackIndex];
    if (!line || line.misfire === undefined) return null;
    // Hint the 5-ft burst from the chosen corner (4 squares) — DC 12 Reflex half, UC p.135
    const squares = firearmExplosionSquares({ col: 0, row: 0 });
    return `Explosion on second early misfire while broken: DC ${FIREARM_EXPLOSION_DC} Reflex half, 5-ft burst (${FIREARM_EXPLOSION_RADIUS_FT} ft, ${squares.length} squares from corner, UC p.135).`;
  }
  async function doFirearmExplosion(): Promise<void> {
    explosionError = "";
    explosionNote = "";
    const line = d.attacks[resolveAttackIndex];
    const raw = explosionDamageRaw.trim();
    const damageFormula = raw !== "" ? raw : line?.damageDice ? `${line.damageDice}${line.damageBonus ? `+${line.damageBonus}` : ""}` : "";
    if (damageFormula === "") { explosionError = "Enter a damage formula for the explosion (e.g. 1d12)."; return; }
    const col = Number.parseInt(explosionCornerColRaw.trim(), 10);
    const row = Number.parseInt(explosionCornerRowRaw.trim(), 10);
    const corner = Number.isFinite(col) && Number.isFinite(row) ? { col, row } : undefined;
    const pickedIds = Object.entries(explosionTargetPicks).filter(([, v]) => v).map(([id]) => id);
    if (pickedIds.length === 0) { explosionError = "Pick at least one target in the 5-ft burst (the 4 squares sharing the chosen corner)."; return; }
    const burstTargets: Array<{ name: string; actor: ActorDocument; derived: ReturnType<typeof pf1eSheetView>["derived"] }> = [];
    for (const id of pickedIds) {
      const actor = client.store.get("actors", id) as ActorDocument | undefined;
      if (!actor) continue;
      burstTargets.push({ name: actor.name, actor, derived: pf1eSheetView(actor).derived });
    }
    if (burstTargets.length === 0) { explosionError = "The picked burst targets are no longer available."; return; }
    explosionBusy = true;
    try {
      const outcome = await resolveFirearmExplosionFlow(client, client.user, {
        attackerName: doc.name,
        damageFormula,
        burstTargets,
        ...(corner ? { corner } : {}),
        ...(resolveVerifiable ? { verifiable: true } : {}),
      });
      if (!outcome.ok) explosionError = outcome.error;
      else {
        const lines = outcome.perTarget.map((p) => `${p.name}: Reflex d20 ${p.die} + ${p.total - p.die} = ${p.total} vs DC ${FIREARM_EXPLOSION_DC} ${p.success ? "success" : "fail"} — ${p.dealt} damage (HP ${p.hpBefore}→${p.hpAfter})${p.hpWriteError ? ` — ${p.hpWriteError}` : ""}`).join(" · ");
        explosionNote = `Explosion ${outcome.damageTotal} damage — ${lines}`;
      }
    } finally { explosionBusy = false; }
  }

  /**
   * P08/D-201 — the mounted higher-ground fold: a rider whose authored mount
   * (`system.pf1e.mount`) is larger than the on-foot target takes +1 on melee
   * attacks (A.11 — the higher-ground bonus, CRB p.202), so the fold is the
   * situational `higherGround` flag the resolver already limits to melee
   * lines. No mount authored, no mount actor, or a mounted target ⇒ nothing.
   */
  let mountedHigher = $derived.by(() => {
    const linkage = mountLinkageOf(
      (doc.system as { pf1e?: { mount?: unknown } }).pf1e?.mount,
    );
    if (linkage === null || linkage.actorId === null) return false;
    const info = resolveTargetInfo();
    if (info === null) return false;
    const mount = client.store.get("actors", linkage.actorId) as
      | ActorDocument
      | undefined;
    if (mount === undefined) return false;
    const targetLinkage = mountLinkageOf(
      (info.actor.system as { pf1e?: { mount?: unknown } }).pf1e?.mount,
    );
    return mountedHigherGround({
      mountSize: (mount.system as { pf1e?: { size?: unknown } }).pf1e?.size,
      targetSize: info.derived.size,
      targetMounted: targetLinkage !== null && targetLinkage.actorId !== null,
    });
  });

  /** The positional defenses the resolver folds in: auto = the geometry's word. */
  /** P08/D-201 — ranged penalty from the selected mount movement (−4 double / −8 run). */
  let mountedRangedPenaltyPart = $derived(mountedRangedPenalty(resolveMountMovement));
  /** P08/D-201 — numeric mount distance for the melee full-attack bar (>5 ft ⇒ single). */
  let resolveMountMovedFt = $derived.by(() => {
    const raw = resolveMountMovedFtRaw.trim();
    if (raw === "") {
      // No explicit feet: infer from mountMovement (stationary 0, single 30, double 60, run 120)
      // so the common horse case (single = >5) correctly bars full attack while 0 keeps it.
      if (resolveMountMovement === "stationary") return 0;
      if (resolveMountMovement === "single") return 30;
      if (resolveMountMovement === "double") return 60;
      return 120;
    }
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) ? Math.max(0, n) : 0;
  });
  let mountedMeleeBar = $derived(mountedMeleeFullAttack({ mountMovedFt: resolveMountMovedFt }));
  /** P08/D-201 — mounted casting DC for the spell level in the cast panel (10+SL / 15+SL). */
  let castMountConcentrationDc = $derived.by(() => {
    const lvl = Number.parseInt(castLevel, 10);
    if (!Number.isInteger(lvl) || lvl < 0 || lvl > 9) return null;
    return mountedCastingConcentrationDC({ spellLevel: lvl, movedBeforeAndAfter: castMountMovedBeforeAndAfter, mountRunning: castMountRunning });
  });

  // P08/D-217 — mount footprint (2×2 for Large horse) and lance hint
  let mountFootprintInfo = $derived.by(() => {
    const linkage = mountLinkageOf((doc.system as { pf1e?: { mount?: unknown } }).pf1e?.mount);
    if (linkage === null || linkage.actorId === null) return null;
    const mount = client.store.get("actors", linkage.actorId) as ActorDocument | undefined;
    if (mount === undefined) return null;
    return mountFootprint({ mountSize: (mount.system as { pf1e?: { size?: unknown } }).pf1e?.size as string | null });
  });
  let lanceHint = $derived.by(() => {
    const line = d.attacks[resolveAttackIndex];
    if (!line || line.ranged === true) return null;
    if (!/lance/i.test(line.name)) return null;
    if (currentMount === null || currentMount.actorId === null) return null;
    if (!resolveCharging) return null;
    const spirited = (Array.isArray(view.authored.feats) ? view.authored.feats as string[] : []).some((f) => /spirited charge/i.test(f));
    const mult = lanceChargeMultiplier({ spiritedCharge: spirited });
    return { mult, spirited };
  });
  // P09/D-218 — derived firearm ammo/misfire/grit for the combat panel + sheet grit readout
  let resolveFirearm = $derived.by(() => {
    const line = d.attacks[resolveAttackIndex];
    if (!line) return null;
    return {
      ammo: line.ammo ?? null,
      misfire: line.misfire ?? null,
      broken: line.misfire?.broken ?? false,
      grit: d.grit,
      canShoot: line.misfire !== undefined ? firearmShotAmmo({ shotsAvailable: line.ammo?.loaded ?? 0 }).canShoot : null,
    };
  });
  let quickClearPreview = $derived(quickClearReloadCost({ gritAvailable: d.grit.current, spendGrit: spendGritForClear }));
  let reloadEntry = $derived(firearmReloadEntry());

  let effectivePositional = $derived.by(() => {
    const concealment =
      resolvePosition.defense.concealment !== undefined
        ? { concealment: resolvePosition.defense.concealment }
        : {};
    if (resolveCoverMode === "auto") return resolvePosition.defense;
    if (resolveCoverMode === "none") return concealment;
    return { cover: resolveCoverMode, ...concealment };
  });

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
    resolveWarning = "";
    const info = resolveTargetInfo();
    const group = attackRolls[resolveAttackIndex];
    const line = d.attacks[resolveAttackIndex];
    if (!info || !group || !line) {
      resolveError = "Pick an attack and a target.";
      return;
    }
    // P02/D-197: a melee line whose target stands beyond its reach refuses
    // before any die is rolled — the pair seam's own refusal names the gap
    // ("the target is 10 ft away — the attack line reaches 5 ft"). Only the
    // readable-position path gates: without scene facts the hand-set flow
    // stands, exactly as the pre-P02 sheet did.
    if (
      line.ranged !== true &&
      resolvePosition.ok &&
      resolvePosition.reach !== null &&
      !resolvePosition.reach.canStrike
    ) {
      resolveError =
        resolvePosition.reach.refusals[0] ??
        "the target is beyond this attack's reach";
      return;
    }
    resolveBusy = true;
    try {
      // D-192: a ranged attack made while threatened provokes before the shot
      // (Table 7-2 attack-ranged); the interrupt resolves first, then the shot.
      if (line.ranged === true) {
        const tokenId = provokerTokenId();
        if (tokenId !== null) {
          const provoke = await resolveActionProvokes({
            client,
            user: client.user,
            provokerTokenId: tokenId,
            provokes: rangedAttackProvokes(),
            autoResolve: autoResolveAoosOf(
              worldSettingsFrom(client.store.getAll("settings")),
            ),
            combat: linked.combat,
          });
          if (provoke.lines.length > 0)
            resolveWarning = provoke.lines.join(" · ");
        }
      }
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
        ...(effectiveFlanking || resolveCharging || mountedHigher
          ? {
              situational: {
                ...(effectiveFlanking ? { flanking: true } : {}),
                ...(resolveCharging ? { charging: true } : {}),
                ...(mountedHigher ? { higherGround: true } : {}),
              },
            }
          : {}),
        // P02 — the pair's positional defenses (cover AC fold, concealment d%),
        // read off the scene when "auto" or the hand-set grade otherwise.
        ...(Object.keys(effectivePositional).length > 0
          ? { positional: effectivePositional }
          : {}),
        ...(resolveNonlethal ? { nonlethalDamage: true } : {}),
        // Only the derived unarmed fallback (no authored attack lines) counts
        // as the unarmed strike for the natural nonlethal bucket and IUS waiver.
        ...(authoredAttacksCount === 0 ? { unarmed: true } : {}),
        ...(Array.isArray(view.authored.feats)
          ? { feats: view.authored.feats as string[] }
          : {}),
        ...(group.provokes ? { provokes: true } : {}),
        attackerBab: Math.trunc(view.derived.baseAttack),
        ...(resolvePowerAttack ? { powerAttack: true } : {}),
        ...(resolveDeadlyAim ? { deadlyAim: true } : {}),
        ...(resolveCombatExpertise ? { combatExpertise: true } : {}),
        ...(resolveFightingDefensively ? { fightingDefensively: true } : {}),
        ...(resolvePointBlank ? { pointBlankShot: true, distanceFt: 0 } : {}),
        ...(line.ranged === true
          ? {
              targetEngaged: resolvePosition.engagement?.targetEngaged ?? false,
              nearestFriendlyDistanceFt: resolvePosition.engagement?.nearestFriendlyDistanceFt ?? null,
              engagedSizeCategoriesLarger: resolvePosition.engagement?.sizeCategoriesLarger ?? 0,
            }
          : {}),
        ...(resolveMountMovement !== "stationary" ? { mountMovement: resolveMountMovement } : {}),
        ...(resolveMountMovedFt > 0 ? { mountMovedFt: resolveMountMovedFt } : {}),
        ...(doc ? { attackerActor: doc, attackerAttackIndex: resolveAttackIndex } : {}),
        ...(resolveExpertLoading ? { misfireExtras: { expertLoading: true } } : {}),
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
  async function resolveManyshotVsTarget(): Promise<void> {
    resolveError = "";
    resolveWarning = "";
    const info = resolveTargetInfo();
    const line = d.attacks[resolveAttackIndex];
    const group = attackRolls[resolveAttackIndex];
    const volley = manyshotRolls(resolveAttackIndex);
    if (!info || !line || !group || volley.length === 0) {
      resolveError = "Pick a ranged Manyshot attack and a target.";
      return;
    }
    manyshotBusy = true;
    try {
      // A Manyshot volley is a ranged attack: it provokes the same interrupt
      // before the arrows fly (Table 7-2 attack-ranged, D-192).
      const tokenId = provokerTokenId();
      if (tokenId !== null) {
        const provoke = await resolveActionProvokes({
          client,
          user: client.user,
          provokerTokenId: tokenId,
          provokes: rangedAttackProvokes(),
          autoResolve: autoResolveAoosOf(
            worldSettingsFrom(client.store.getAll("settings")),
          ),
          combat: linked.combat,
        });
        if (provoke.lines.length > 0)
          resolveWarning = provoke.lines.join(" · ");
      }
      const outcome = await resolveManyshotFlow(client, client.user, {
        attackerName: doc.name,
        line,
        attackFormulas: volley.map((spec) => spec.formula),
        damageFormula: group.damage?.formula ?? "0",
        critDamageFormula: group.critDamage?.formula ?? null,
        targetName: info.actor.name,
        targetActor: info.actor,
        targetDerived: info.derived,
        defense: resolveDefense,
        ...(effectiveFlanking || resolveCharging || mountedHigher
          ? {
              situational: {
                ...(effectiveFlanking ? { flanking: true } : {}),
                ...(resolveCharging ? { charging: true } : {}),
                ...(mountedHigher ? { higherGround: true } : {}),
              },
            }
          : {}),
        // P02 — positional defenses fold into every arrow (cover AC, concealment d%).
        ...(Object.keys(effectivePositional).length > 0
          ? { positional: effectivePositional }
          : {}),
        ...(resolveNonlethal ? { nonlethalDamage: true } : {}),
        ...(Array.isArray(view.authored.feats)
          ? { feats: view.authored.feats as string[] }
          : {}),
        attackerBab: Math.trunc(view.derived.baseAttack),
        ...(resolvePowerAttack ? { powerAttack: true } : {}),
        ...(resolveDeadlyAim ? { deadlyAim: true } : {}),
        ...(resolveCombatExpertise ? { combatExpertise: true } : {}),
        ...(resolveFightingDefensively ? { fightingDefensively: true } : {}),
        ...(resolvePointBlank ? { pointBlankShot: true, distanceFt: 0 } : {}),
        ...(line.ranged === true
          ? {
              targetEngaged: resolvePosition.engagement?.targetEngaged ?? false,
              nearestFriendlyDistanceFt: resolvePosition.engagement?.nearestFriendlyDistanceFt ?? null,
              engagedSizeCategoriesLarger: resolvePosition.engagement?.sizeCategoriesLarger ?? 0,
            }
          : {}),
        ...(resolveMountMovement !== "stationary" ? { mountMovement: resolveMountMovement } : {}),
        ...(resolveExpertLoading ? { misfireExtras: { expertLoading: true } } : {}),
        ...(resolveVerifiable ? { verifiable: true } : {}),
      });
      if (!outcome.ok) resolveError = outcome.error;
    } finally {
      manyshotBusy = false;
    }
  }

  function maneuverTargetInfo(): {
    actor: ActorDocument;
  } | null {
    if (!maneuverTargetId) return null;
    const actor = client.store.get("actors", maneuverTargetId) as ActorDocument | undefined;
    if (!actor) return null;
    return { actor };
  }

  let maneuverPosition = $derived(
    pf1eResolvePositionReport({
      scene: activeSceneOf(
        client.store.getAll("scenes") as readonly SceneDocument[],
        DEFAULT_SCENE_ID,
      ),
      actors: client.store.getAll("actors") as readonly ActorDocument[],
      attackerActorId: doc._id,
      targetActorId: maneuverTargetId,
      ranged: false,
    }),
  );

  let maneuverEffectivePositional = $derived.by(() => {
    const concealment =
      maneuverPosition.defense?.concealment !== undefined
        ? { concealment: maneuverPosition.defense.concealment }
        : undefined;
    return concealment;
  });

  async function resolveManeuver(): Promise<void> {
    maneuverError = "";
    maneuverWarning = "";
    const info = maneuverTargetInfo();
    if (!info) {
      maneuverError = "Pick a maneuver target.";
      return;
    }
    const current = client.store.get("actors", doc._id) as ActorDocument | undefined;
    if (!current) {
      maneuverError = "Actor is no longer available.";
      return;
    }
    maneuverBusy = true;
    try {
      const scene = activeSceneOf(
        client.store.getAll("scenes") as readonly SceneDocument[],
        DEFAULT_SCENE_ID,
      );
      const tokens = (scene?.tokens ?? []) as unknown as readonly { _id: string; actorId?: string | null }[];
      const outcome = await resolveManeuverFlow(client as unknown as import("../combat/pf1eManeuverFlow").ManeuverFlowClient, client.user, {
        attacker: current,
        defender: info.actor,
        kind: maneuverKind as unknown as import("../combat/pf1eManeuverFlow").ManeuverFlowKind,
        combat: linked.combat,
        tokens,
        scene: scene ?? null,
        hasImprovedFeat: maneuverHasImproved,
        ...(maneuverEffectivePositional !== undefined ? maneuverEffectivePositional : {}),
        ...(maneuverVerifiable ? { verifiable: true } : {}),
        grappleOpts: { targetAdjacent: true, hasAdjacentSpace: true },
      });
      if (!outcome.ok) maneuverError = outcome.error;
      else if (outcome.aooDamage) maneuverWarning = `AoO dealt ${outcome.aooDamage} — applied as penalty.`;
      else maneuverWarning = outcome.plan.note ?? "";
    } finally {
      maneuverBusy = false;
    }
  }

  function aidAidedInfo(): ActorDocument | null {
    if (!aidAidedId) return null;
    return (client.store.get("actors", aidAidedId) as ActorDocument | undefined) ?? null;
  }
  function aidOpponentInfo(): ActorDocument | null {
    if (!aidOpponentId) return null;
    return (client.store.get("actors", aidOpponentId) as ActorDocument | undefined) ?? null;
  }
  function feintTargetInfo(): ActorDocument | null {
    if (!feintTargetId) return null;
    return (client.store.get("actors", feintTargetId) as ActorDocument | undefined) ?? null;
  }

  async function resolveAid(): Promise<void> {
    aidError = "";
    aidWarning = "";
    const aided = aidAidedInfo();
    const opponent = aidOpponentInfo();
    if (!aided || !opponent) {
      aidError = "Pick an aided ally and an opponent.";
      return;
    }
    const current = client.store.get("actors", doc._id) as ActorDocument | undefined;
    if (!current) { aidError = "Actor is no longer available."; return; }
    aidBusy = true;
    try {
      const scene = activeSceneOf(client.store.getAll("scenes") as readonly SceneDocument[], DEFAULT_SCENE_ID);
      const tokens = (scene?.tokens ?? []) as unknown as readonly { _id: string; actorId?: string | null }[];
      const outcome = await resolveAidAnotherFlow(client as unknown as import("../combat/pf1eAidFeintFlow").AidFeintFlowClient, client.user, {
        aider: current,
        aided,
        opponent,
        combat: linked.combat,
        tokens,
        scene: scene ?? null,
        aidedActionProvokes: aidAidedProvokes,
        aidChoice,
        ...(aidVerifiable ? { verifiable: true } : {}),
      });
      if (!outcome.ok) aidError = outcome.error;
      else if (outcome.aooDamage !== undefined) aidWarning = `AoO dealt ${outcome.aooDamage} — applied as penalty. ${outcome.plan.note ?? ""}`;
      else aidWarning = outcome.plan.note ?? "";
    } finally { aidBusy = false; }
  }

  async function resolveFeint(): Promise<void> {
    feintError = "";
    feintWarning = "";
    const target = feintTargetInfo();
    if (!target) { feintError = "Pick a feint target."; return; }
    const current = client.store.get("actors", doc._id) as ActorDocument | undefined;
    if (!current) { feintError = "Actor is no longer available."; return; }
    const bluffBonus = feintBluffBonusRaw.trim() === "" ? 0 : Number.parseInt(feintBluffBonusRaw, 10);
    if (!Number.isFinite(bluffBonus)) { feintError = "Bluff bonus must be a whole number."; return; }
    feintBusy = true;
    try {
      const scene = activeSceneOf(client.store.getAll("scenes") as readonly SceneDocument[], DEFAULT_SCENE_ID);
      const tokens = (scene?.tokens ?? []) as unknown as readonly { _id: string; actorId?: string | null }[];
      const derived = pf1eSheetView(target).derived;
      const outcome = await resolveFeintFlow(client as unknown as import("../combat/pf1eAidFeintFlow").AidFeintFlowClient, client.user, {
        feinter: current,
        target,
        bluffBonus,
        hasImprovedFeint: feintHasImproved,
        hasGreaterFeint: feintHasGreater,
        targetIsHumanoid: true,
        targetIntScore: (derived as { abilities?: Record<string, number> }).abilities?.int ?? null,
        combat: linked.combat,
        tokens,
        scene: scene ?? null,
        ...(feintVerifiable ? { verifiable: true } : {}),
      });
      if (!outcome.ok) feintError = outcome.error;
      else feintWarning = outcome.plan.note ?? "";
    } finally { feintBusy = false; }
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

  function updateSpellbook(edit: PF1eSpellbookEdit): void {
    const current = client.store.get("actors", doc._id) as
      ActorDocument | undefined;
    if (!current) {
      error = "Actor is no longer available.";
      return;
    }
    // Re-derive from the freshest copy so dotted diffs hit the live document.
    const derived = pf1eSheetView(current, {
      combat: linked.combat,
      combatantId: linked.combatantId,
    }).derived;
    const result = pf1eSpellbookEdit(current, derived, client.user, edit);
    error = result.error ?? "";
    spellbookWarning = result.warning ?? "";
    if (result.ops.length) pending.add(client.submit(result.ops));
  }

  function prepareSpell(event: Event): void {
    event.preventDefault();
    const level = Number.parseInt(prepareLevel, 10);
    const slotLevel =
      prepareSlotLevel === ""
        ? undefined
        : Number.parseInt(prepareSlotLevel, 10);
    const components =
      prepareComponents.trim() === "" ? undefined : prepareComponents.trim();
    updateSpellbook({
      kind: "prepare",
      name: prepareName,
      level,
      slotLevel,
      components,
    });
    if (!error) {
      prepareName = "";
      prepareComponents = "";
    }
  }

  function fillCastFromPrepared(index: number): void {
    const row = spellbook.prepared[index];
    if (!row) return;
    castPreparedIndex = index;
    castName = row.name;
    castLevel = String(row.level);
    castSlot = row.slotLevel === row.level ? "" : String(row.slotLevel);
    // A prepared row's Components line pins the C03a gate for this cast.
    castComponents = row.components;
  }

  async function castAtTarget(): Promise<void> {
    castError = "";
    castWarning = "";
    const target = castTargetId
      ? (client.store.get("actors", castTargetId) as ActorDocument | undefined)
      : undefined;
    if (!target) {
      castError = "Pick a target.";
      return;
    }
    const current = client.store.get("actors", doc._id) as
      ActorDocument | undefined;
    if (!current) {
      castError = "Actor is no longer available.";
      return;
    }
    // Fresh derivation for both parties, so DCs, saves and SR are live.
    const casterView = pf1eSheetView(current, {
      combat: linked.combat,
      combatantId: linked.combatantId,
    });
    const targetView = pf1eSheetView(target);
    let level = Number.parseInt(castLevel, 10);
    let slotLevel = castSlot === "" ? level : Number.parseInt(castSlot, 10);
    let name = castName.trim();
    // A picked prepared row pins the spell's identity (name/level/slot).
    if (d.spellMode === "prepared" && castPreparedIndex !== null) {
      const preparedRow = spellbook.prepared[castPreparedIndex];
      if (preparedRow) {
        name = preparedRow.name;
        level = preparedRow.level;
        slotLevel = preparedRow.slotLevel;
      }
    }
    if (name === "") name = `Level ${level} spell`;
    const spell: PF1eCastFlowParams["spell"] = { name, level };
    if (slotLevel !== level) spell.slotLevel = slotLevel;
    if (d.spellMode === "prepared" && castPreparedIndex !== null)
      spell.preparedIndex = castPreparedIndex;
    const authored: PF1eCastFlowParams["authored"] = {
      saveType: castSaveType,
      severity: castSeverity,
      damageFormula: castDamage.trim(),
    };
    if (castEnergy !== "") authored.energyType = castEnergy as PF1eEnergyType;
    // The C03a gate (D-157) runs whenever a Components line is declared.
    const gateComponents = castComponents.trim();
    const declarations: PF1eConcentrationDeclaration[] = [];
    if (castDefensively) declarations.push({ situation: "castDefensively" });
    if (castInjured)
      declarations.push({
        situation: "injured",
        damage: Math.max(0, Math.trunc(Number(castInjuredDamage) || 0)),
      });
    if (
      castMotion === "vigorousMotion" ||
      castMotion === "violentMotion" ||
      castMotion === "extremelyViolentMotion"
    )
      declarations.push({ situation: castMotion });
    if (castWeather === "windRainSleet" || castWeather === "windHailDebris")
      declarations.push({ situation: castWeather });
    if (castEntangled) declarations.push({ situation: "entangled" });
    if (castContinuous)
      declarations.push({
        situation: "continuousDamage",
        damage: Math.max(0, Math.trunc(Number(castContinuousAmount) || 0)),
      });
    if (castNonDamaging)
      declarations.push({
        situation: "nonDamagingSpell",
        spellDc: Math.max(0, Math.trunc(Number(castNonDamagingDc) || 0)),
      });
    if (castGrappleCheck)
      declarations.push({
        situation: "grappledOrPinned",
        grapplerCmb: Math.max(0, Math.trunc(Number(castGrappleCmb) || 0)),
      });
    // P08/D-201 — mounted casting (A.11): moving both before and after ⇒ DC 10+SL (vigorous),
    // running ⇒ DC 15+SL (violent). The DCs match Table 9-1 motion rows, so we reuse them.
    if (castMountRunning) declarations.push({ situation: "violentMotion" });
    else if (castMountMovedBeforeAndAfter) declarations.push({ situation: "vigorousMotion" });
    castBusy = true;
    try {
      // D-191: the casting provoke resolves (or reports) before the spell lands — the
      // attack interrupts the cast (AoN 102), and its damage feeds the cast gate's
      // `injured` concentration check (10 + damage + level, AoN 133).
      let provokeNotes: string[] = [];
      const tokenId = provokerTokenId();
      const provokes = castProvokes({
        castingTime: castTime as PF1eCastingTime,
        quickened: castQuickened,
        defensively: castDefensively,
        ...(castTouch !== "" ? { touch: castTouch as "melee" | "ranged" } : {}),
      });
      if (provokes.length > 0 && tokenId !== null) {
        const provoke = await resolveActionProvokes({
          client,
          user: client.user,
          provokerTokenId: tokenId,
          provokes,
          autoResolve: autoResolveAoosOf(
            worldSettingsFrom(client.store.getAll("settings")),
          ),
          combat: linked.combat,
        });
        provokeNotes = provoke.lines;
        if (provoke.damage > 0)
          declarations.push({ situation: "injured", damage: provoke.damage });
      }
      const outcome = await resolveCastFlow(client, client.user, {
        casterActor: current,
        casterDerived: casterView.derived,
        spell,
        authored,
        targetName: target.name,
        targetActor: target,
        targetDerived: targetView.derived,
        targetFeats: Array.isArray(targetView.authored.feats)
          ? (targetView.authored.feats as string[])
          : [],
        combat: linked.combat,
        ...(castSrOvercome ? { srOvercomeByCaller: true } : {}),
        castingTime: castTime as PF1eCastingTime,
        ...(castTouch !== "" ? { touch: castTouch as "melee" | "ranged" } : {}),
        ...(castTouch !== "" && castWilling ? { willing: true } : {}),
        // D-162: a melee touch may hold several deliveries (Chill Touch holds
        // one per level); garbage in the field surfaces the flow's named error.
        ...(castTouch === "melee" && castCharges.trim() !== ""
          ? {
              charges: (() => {
                const parsed = Number.parseInt(castCharges.trim(), 10);
                return Number.isNaN(parsed) ? Number.NaN : parsed;
              })(),
            }
          : {}),
        // D-163: a quickened cast rides the turn's swift action.
        ...(castQuickened ? { quickened: true } : {}),
        ...(linked.combatantId !== null && linked.combatantId !== undefined
          ? { combatantId: linked.combatantId }
          : {}),
        ...(gateComponents !== ""
          ? {
              gate: {
                components: gateComponents,
                caster: {
                  canSpeak: !castCannotSpeak,
                  hasFreeHand: !castNoFreeHand,
                  componentsInHand: !castNoComponentsInHand,
                  deafened: castDeafened,
                  grappled: castGrappled,
                  pinned: castPinned,
                },
                castingTime: castTime as PF1eCastingTime,
                declarations,
              },
            }
          : {}),
      });
      if (!outcome.ok) {
        castError = outcome.error;
      } else if (outcome.pending) {
        castWarning =
          "the casting has begun — it comes into effect just before your next turn";
      } else if (outcome.held) {
        castWarning =
          "the touch attack missed — the charge is held; deliver it below";
      } else if (outcome.lost) {
        castWarning = [...outcome.gateNotes, ...outcome.warnings].join(" · ");
      } else {
        const bits: string[] = [...outcome.gateNotes, ...outcome.warnings];
        if (outcome.hpWriteError !== null) bits.push(outcome.hpWriteError);
        castWarning = bits.join(" · ");
      }
      // D-191: the provoke's own lines ride alongside whatever the cast reported —
      // the attack happened before the spell, so the GM reads both in one place.
      if (provokeNotes.length > 0) {
        castWarning =
          castWarning === ""
            ? provokeNotes.join(" · ")
            : `${provokeNotes.join(" · ")} · ${castWarning}`;
      }
    } finally {
      castBusy = false;
    }
  }

  // D-158 — deliver or dissipate a held touch-spell charge. The delivery
  // re-reads the freshest documents, so a stale tab cannot overwrite state.
  async function deliverHeldCharge(willing: boolean): Promise<void> {
    castError = "";
    castWarning = "";
    const target = castTargetId
      ? (client.store.get("actors", castTargetId) as ActorDocument | undefined)
      : undefined;
    if (!target) {
      castError = "Pick a target to deliver the held charge.";
      return;
    }
    const current = client.store.get("actors", doc._id) as
      ActorDocument | undefined;
    if (!current) {
      castError = "Actor is no longer available.";
      return;
    }
    const casterView = pf1eSheetView(current, {
      combat: linked.combat,
      combatantId: linked.combatantId,
    });
    const targetView = pf1eSheetView(target);
    castBusy = true;
    try {
      const outcome = await resolveTouchDelivery(client, client.user, {
        casterActor: current,
        casterDerived: casterView.derived,
        targetName: target.name,
        targetActor: target,
        targetDerived: targetView.derived,
        targetFeats: Array.isArray(targetView.authored.feats)
          ? (targetView.authored.feats as string[])
          : [],
        combat: linked.combat,
        ...(castSrOvercome ? { srOvercomeByCaller: true } : {}),
        ...(willing ? { willing: true } : {}),
      });
      if (!outcome.ok) {
        castError = outcome.error;
      } else if (!outcome.delivered) {
        castWarning = "the delivery missed — the charge is still held";
      } else if (outcome.hpWriteError !== null) {
        castWarning = outcome.hpWriteError;
      } else if (outcome.chargesRemaining !== undefined) {
        castWarning = `the charge landed — ${outcome.chargesRemaining} deliveries remain`;
      }
    } finally {
      castBusy = false;
    }
  }

  // D-162 — touch willing allies with the held charge: one friend as a
  // standard action, up to six friends as a full-round action (Rules ID
  // 133). No attack rolls; each touched ally consumes one charge.
  async function touchWillingAllies(): Promise<void> {
    castError = "";
    castWarning = "";
    const current = client.store.get("actors", doc._id) as
      ActorDocument | undefined;
    if (!current) {
      castError = "Actor is no longer available.";
      return;
    }
    const pickedIds = Object.entries(allyTouchPicks)
      .filter(([, picked]) => picked)
      .map(([id]) => id);
    if (pickedIds.length === 0) {
      castError = "Pick at least one willing ally to touch.";
      return;
    }
    const targets = [];
    for (const id of pickedIds) {
      const target = client.store.get("actors", id) as
        ActorDocument | undefined;
      if (!target) continue;
      const targetView = pf1eSheetView(target);
      targets.push({
        name: target.name,
        actor: target,
        derived: targetView.derived,
        feats: Array.isArray(targetView.authored.feats)
          ? (targetView.authored.feats as string[])
          : [],
      });
    }
    if (targets.length === 0) {
      castError = "The picked allies are no longer available.";
      return;
    }
    const casterView = pf1eSheetView(current, {
      combat: linked.combat,
      combatantId: linked.combatantId,
    });
    castBusy = true;
    try {
      const outcome = await resolveChargeAllyTouches(client, client.user, {
        casterActor: current,
        casterDerived: casterView.derived,
        targets,
        combat: linked.combat,
        ...(castSrOvercome ? { srOvercomeByCaller: true } : {}),
      });
      if (!outcome.ok) {
        castError = outcome.error;
      } else {
        const hpErrors = outcome.perTarget
          .filter((t) => t.hpWriteError !== null)
          .map((t) => `${t.name}: ${t.hpWriteError}`);
        const bits = [
          outcome.chargesRemaining !== undefined
            ? `touched ${String(outcome.touched)} ${outcome.touched === 1 ? "ally" : "allies"} — ${String(outcome.chargesRemaining)} deliveries remain`
            : `touched ${String(outcome.touched)} ${outcome.touched === 1 ? "ally" : "allies"} — the spell is fully discharged`,
          ...hpErrors,
        ];
        castWarning = bits.join(" · ");
        allyTouchPicks = {};
      }
    } finally {
      castBusy = false;
    }
  }

  // D-162 — release the held charge through a normal unarmed or natural
  // weapon attack: the line's normal bonus vs the target's normal AC; on a
  // hit the weapon deals its damage and the spell discharges (Rules ID 133).
  async function releaseHeldChargeThroughAttack(): Promise<void> {
    castError = "";
    castWarning = "";
    const target = castTargetId
      ? (client.store.get("actors", castTargetId) as ActorDocument | undefined)
      : undefined;
    if (!target) {
      castError = "Pick a target to release the held charge.";
      return;
    }
    const current = client.store.get("actors", doc._id) as
      ActorDocument | undefined;
    if (!current) {
      castError = "Actor is no longer available.";
      return;
    }
    const line = d.attacks[releaseAttackIndex];
    if (!line) {
      castError =
        "No authored attack line is available for the release — add an unarmed strike or natural weapon first.";
      return;
    }
    const casterView = pf1eSheetView(current, {
      combat: linked.combat,
      combatantId: linked.combatantId,
    });
    const targetView = pf1eSheetView(target);
    castBusy = true;
    try {
      const outcome = await resolveChargeWeaponRelease(client, client.user, {
        casterActor: current,
        casterDerived: casterView.derived,
        targetName: target.name,
        targetActor: target,
        targetDerived: targetView.derived,
        weapon: {
          name: line.name,
          attackBonus: line.attackBonus,
          damageFormula: line.damageDice ?? "",
          damageBonus: line.damageBonus,
        },
        targetFeats: Array.isArray(targetView.authored.feats)
          ? (targetView.authored.feats as string[])
          : [],
        combat: linked.combat,
        ...(castSrOvercome ? { srOvercomeByCaller: true } : {}),
      });
      if (!outcome.ok) {
        castError = outcome.error;
      } else if (!outcome.released) {
        castWarning = "the release attack missed — the charge is still held";
      } else if (outcome.hpWriteError !== null) {
        castWarning = outcome.hpWriteError;
      } else if (outcome.chargesRemaining !== undefined) {
        castWarning = `the charge discharged — ${String(outcome.chargesRemaining)} deliveries remain`;
      }
    } finally {
      castBusy = false;
    }
  }

  function dismissHeldCharge(): void {
    castError = "";
    castWarning = "";
    const current = client.store.get("actors", doc._id) as
      ActorDocument | undefined;
    if (!current) return;
    if (
      !isPF1eActor(current) ||
      !client.user ||
      !can(client.user, "update", current, "actors")
    ) {
      castError = "You do not have permission to act for this caster.";
      return;
    }
    pending.add(
      client.submit([
        {
          kind: "update",
          ref: { coll: "actors", id: current._id },
          diff: heldChargeDiff(null),
        },
      ]),
    );
  }

  // D-161 — complete a pending multi-round casting. The effect rides the
  // original target, so we resolve it from the stored targetId rather than
  // the current cast-target select.
  async function completePendingCast(): Promise<void> {
    castError = "";
    castWarning = "";
    const current = client.store.get("actors", doc._id) as
      ActorDocument | undefined;
    if (!current) {
      castError = "Actor is no longer available.";
      return;
    }
    const pending = pendingCastFromSystem(
      current.system as Record<string, unknown>,
    );
    if (!pending) {
      castError = "There is no pending casting to complete.";
      return;
    }
    const target = client.store.get("actors", pending.targetId) as
      ActorDocument | undefined;
    if (!target) {
      castError =
        "The spell's original target is gone — lose the casting instead.";
      return;
    }
    const casterView = pf1eSheetView(current, {
      combat: linked.combat,
      combatantId: linked.combatantId,
    });
    const targetView = pf1eSheetView(target);
    castBusy = true;
    try {
      const outcome = await resolvePendingCompletion(client, client.user, {
        casterActor: current,
        casterDerived: casterView.derived,
        targetName: target.name,
        targetActor: target,
        targetDerived: targetView.derived,
        targetFeats: Array.isArray(targetView.authored.feats)
          ? (targetView.authored.feats as string[])
          : [],
        combat: linked.combat,
        ...(castSrOvercome ? { srOvercomeByCaller: true } : {}),
      });
      if (!outcome.ok) {
        castError = outcome.error;
      } else if (outcome.hpWriteError !== null) {
        castWarning = outcome.hpWriteError;
      }
    } finally {
      castBusy = false;
    }
  }

  // D-161 — damage taken while a multi-round casting is in progress forces a
  // concentration check (DC 10 + damage + spell level).
  async function checkPendingDisruption(): Promise<void> {
    castError = "";
    castWarning = "";
    const current = client.store.get("actors", doc._id) as
      ActorDocument | undefined;
    if (!current) {
      castError = "Actor is no longer available.";
      return;
    }
    const casterView = pf1eSheetView(current, {
      combat: linked.combat,
      combatantId: linked.combatantId,
    });
    const damage = Math.max(0, Math.trunc(Number(pendingDisruptDamage) || 0));
    castBusy = true;
    try {
      const outcome = await resolvePendingDisruption(client, client.user, {
        casterActor: current,
        casterDerived: casterView.derived,
        damage,
      });
      if (!outcome.ok) {
        castError = outcome.error;
      } else {
        castWarning = outcome.lost
          ? `the concentration check failed (${outcome.total} vs DC ${outcome.dc}) — the pending ${outcome.spellName} is lost`
          : `concentration held (${outcome.total} vs DC ${outcome.dc}) — the casting continues`;
      }
    } finally {
      castBusy = false;
    }
  }

  // D-161 — the GM forfeits the pending casting outright.
  function abandonPendingCast(): void {
    castError = "";
    castWarning = "";
    const current = client.store.get("actors", doc._id) as
      ActorDocument | undefined;
    if (!current) return;
    if (
      !isPF1eActor(current) ||
      !client.user ||
      !can(client.user, "update", current, "actors")
    ) {
      castError = "You do not have permission to act for this caster.";
      return;
    }
    pending.add(
      client.submit([
        {
          kind: "update",
          ref: { coll: "actors", id: current._id },
          diff: pendingCastDiff(null),
        },
      ]),
    );
  }

  // D-206 — natural recovery (H03, AoN 170): level per night, 2× bed rest, long-term care.
  function doRest(): void {
    restNote = "";
    error = "";
    const current = client.store.get("actors", doc._id) as
      ActorDocument | undefined;
    if (!current) {
      error = "Actor is no longer available.";
      return;
    }
    if (
      !isPF1eActor(current) ||
      !client.user ||
      !can(client.user, "update", current, "actors")
    ) {
      error = "You do not have permission to rest this actor.";
      return;
    }
    const parsed = restLevelOverride.trim();
    const level =
      parsed !== ""
        ? Number.parseInt(parsed, 10)
        : restLevelOf(current);
    if (!Number.isFinite(level) || level < 0) {
      error = "Rest level must be a non-negative number.";
      return;
    }
    const plan = planRest({
      actor: current,
      level,
      bedRest: restBed,
      longTermCare: restCare,
    });
    if (plan.ops.length > 0) pending.add(client.submit(plan.ops));
    restNote = plan.note;
  }

  // P7/H02 — apply magical/mundane healing (CRB p.191).
  function doHealing(): void {
    healNote = "";
    error = "";
    const current = client.store.get("actors", doc._id) as
      ActorDocument | undefined;
    if (!current) {
      error = "Actor is no longer available.";
      return;
    }
    if (
      !isPF1eActor(current) ||
      !client.user ||
      !can(client.user, "update", current, "actors")
    ) {
      error = "You do not have permission to heal this actor.";
      return;
    }
    const raw = healAmountRaw.trim();
    const amount = Number.parseInt(raw, 10);
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      error = "Healing amount must be a positive whole number.";
      return;
    }
    const derived = pf1eSheetView(current).derived;
    const result = applyHealing({
      hp: derived.hp,
      hpMax: derived.hpMax,
      nonlethalDamage: derived.nonlethalDamage,
      amount,
    });
    if ((result as unknown as { ok: false }).ok === false) {
      error = (result as unknown as { error: string }).error;
      return;
    }
    const r = result as unknown as { hp: number; nonlethalDamage: number; note: string };
    const diff: Record<string, unknown> = {};
    if (r.hp !== derived.hp) diff["system.pf1e.hp"] = r.hp;
    if (r.nonlethalDamage !== derived.nonlethalDamage) diff["system.pf1e.nonlethalDamage"] = r.nonlethalDamage;
    if (Object.keys(diff).length === 0) {
      healNote = r.note;
      return;
    }
    pending.add(
      client.submit([
        { kind: "update", ref: { coll: "actors", id: current._id }, diff: diff as unknown as Record<string, import("../../core/documents").Json> },
      ]),
    );
    healNote = r.note;
  }

  // P7/H02 — grant or expire temporary hit points by source.
  function doGrantTempHp(): void {
    tempHpNote = "";
    error = "";
    const current = client.store.get("actors", doc._id) as ActorDocument | undefined;
    if (!current) { error = "Actor is no longer available."; return; }
    if (!isPF1eActor(current) || !client.user || !can(client.user, "update", current, "actors")) {
      error = "You do not have permission to grant temporary HP."; return;
    }
    const id = tempHpSourceId.trim();
    const amount = Number.parseInt(tempHpAmountRaw.trim(), 10);
    if (id === "") { error = "Source id must be non-empty."; return; }
    if (!Number.isSafeInteger(amount) || amount <= 0) { error = "Amount must be a positive whole number."; return; }
    const derived = pf1eSheetView(current).derived;
    const result = grantTempHp(derived.tempHpSources, id, amount);
    if (result.issues.length > 0) { error = result.issues.join(" "); return; }
    const diff: Record<string, unknown> = {};
    diff["system.pf1e.tempHpSources"] = result.sources as unknown as Record<string, unknown>;
    diff["-=system.pf1e.tempHp"] = null;
    pending.add(client.submit([{ kind: "update", ref: { coll: "actors", id: current._id }, diff: diff as unknown as Record<string, import("../../core/documents").Json> }]));
    tempHpNote = result.note ?? `granted ${amount} temp HP from ${id} — total ${result.total}`;
  }
  function doExpireTempHp(): void {
    tempHpNote = "";
    error = "";
    const current = client.store.get("actors", doc._id) as ActorDocument | undefined;
    if (!current) { error = "Actor is no longer available."; return; }
    if (!isPF1eActor(current) || !client.user || !can(client.user, "update", current, "actors")) {
      error = "You do not have permission to expire temporary HP."; return;
    }
    const id = tempHpExpireId.trim();
    if (id === "") { error = "Source id to expire must be non-empty."; return; }
    const derived = pf1eSheetView(current).derived;
    if (!(id in derived.tempHpSources)) { error = `No such temp HP source: ${id}`; return; }
    const result = expireTempHpSource(derived.tempHpSources, id);
    const diff: Record<string, unknown> = {};
    if (Object.keys(result.sources).length === 0) {
      diff["-=system.pf1e.tempHpSources"] = null;
      diff["-=system.pf1e.tempHp"] = null;
    } else {
      diff["system.pf1e.tempHpSources"] = result.sources as unknown as Record<string, unknown>;
      diff["-=system.pf1e.tempHp"] = null;
    }
    pending.add(client.submit([{ kind: "update", ref: { coll: "actors", id: current._id }, diff: diff as unknown as Record<string, import("../../core/documents").Json> }]));
    tempHpNote = result.note ?? "expired";
  }

  // P7/H04 — negative levels: inflict, 24h save, restoration.
  function doInflictNegativeLevels(): void {
    negativeLevelsNote = "";
    error = "";
    const current = client.store.get("actors", doc._id) as ActorDocument | undefined;
    if (!current) { error = "Actor is no longer available."; return; }
    if (!isPF1eActor(current) || !client.user || !can(client.user, "update", current, "actors")) {
      error = "You do not have permission to inflict negative levels."; return;
    }
    const count = Number.parseInt(negativeLevelsCountRaw.trim(), 10);
    if (!Number.isSafeInteger(count) || count <= 0) { error = "Count must be a positive whole number (≥1)."; return; }
    const res = planEnergyDrainInflict({ defender: current, count, kind: negativeLevelsKind });
    if (!res.ok) { error = res.error; return; }
    if (res.plan.ops.length > 0) pending.add(client.submit(res.plan.ops));
    negativeLevelsNote = res.plan.note;
  }
  function doNegativeLevelSave(): void {
    negativeLevelsNote = "";
    error = "";
    const current = client.store.get("actors", doc._id) as ActorDocument | undefined;
    if (!current) { error = "Actor is no longer available."; return; }
    if (!isPF1eActor(current) || !client.user || !can(client.user, "update", current, "actors")) {
      error = "You do not have permission to roll a negative-level save."; return;
    }
    const die = Number.parseInt(negativeLevelDieRaw.trim(), 10);
    const fortBonus = Number.parseInt(negativeLevelFortRaw.trim(), 10);
    const dc = Number.parseInt(negativeLevelDcRaw.trim(), 10);
    if (!Number.isSafeInteger(die) || die < 1 || die > 20) { error = "Die must be a natural d20 face (1–20)."; return; }
    if (!Number.isSafeInteger(fortBonus)) { error = "Fort bonus must be a whole number."; return; }
    if (!Number.isSafeInteger(dc)) { error = "DC must be a whole number."; return; }
    const res = planNegativeLevelSave({ actor: current, kind: negativeLevelSaveKind, die, fortBonus, dc });
    if (!res.ok) { error = res.error; return; }
    if (res.plan.ops.length > 0) pending.add(client.submit(res.plan.ops));
    negativeLevelsNote = res.plan.note;
  }
  function doRestoration(): void {
    negativeLevelsNote = "";
    error = "";
    const current = client.store.get("actors", doc._id) as ActorDocument | undefined;
    if (!current) { error = "Actor is no longer available."; return; }
    if (!isPF1eActor(current) || !client.user || !can(client.user, "update", current, "actors")) {
      error = "You do not have permission to restore negative levels."; return;
    }
    const count = Number.parseInt(restorationCountRaw.trim(), 10);
    if (!Number.isSafeInteger(count) || count <= 0) { error = "Count must be a positive whole number (≥1)."; return; }
    const res = planRestoration({ actor: current, count, kind: restorationKind });
    if (!res.ok) { error = res.error; return; }
    if (res.plan.ops.length > 0) pending.add(client.submit(res.plan.ops));
    negativeLevelsNote = res.plan.note;
  }

  // E01/E02 — the effect apply/edit/toggle/remove handlers. Both homes resolve
  // fresh documents from the projected store, so a stale tab cannot write over
  // a replica that moved on; the ops go through ClientSync like every edit.
  function linkedCombatantDoc(): {
    combat: CombatDocument;
    member: CombatantDocument;
  } | null {
    if (!linked.combat || !linked.combatantId) return null;
    const combat = client.store.get("combats", linked.combat._id) as
      CombatDocument | undefined;
    const member = combat?.combatants.find(
      (c) => c._id === linked.combatantId,
    ) as CombatantDocument | undefined;
    return combat && member ? { combat, member } : null;
  }

  function combatantEffectIds(member: CombatantDocument): Set<string> {
    const core = (
      member.flags as Record<string, Record<string, unknown>> | undefined
    )?.core;
    const effects = core?.effects;
    return effects !== null &&
      typeof effects === "object" &&
      !Array.isArray(effects)
      ? new Set(Object.keys(effects as object))
      : new Set<string>();
  }

  function applyEffect(request: {
    name: string;
    icon?: string;
    payload: Parameters<typeof pf1eApplyActorEffect>[2]["payload"];
    target: "actor" | "combatant";
    effectId?: string;
  }): void {
    const current = client.store.get("actors", doc._id) as
      ActorDocument | undefined;
    if (!current) {
      error = "Actor is no longer available.";
      return;
    }
    const linkedNow = linkedCombatantDoc();

    // E02 edit mode: the effect's current home decides which edit op runs.
    if (request.effectId !== undefined) {
      if (
        linkedNow &&
        combatantEffectIds(linkedNow.member).has(request.effectId)
      ) {
        const result = pf1eEditCombatantEffect(
          linkedNow.combat,
          client.user,
          linkedNow.member._id,
          request.effectId,
          request,
        );
        error = result.error ?? "";
        if (result.ops.length) pending.add(client.submit(result.ops));
        return;
      }
      const result = pf1eEditActorEffect(
        current,
        client.user,
        request.effectId,
        request,
      );
      error = result.error ?? "";
      if (result.ops.length) pending.add(client.submit(result.ops));
      return;
    }

    if (request.target === "combatant" && linkedNow) {
      const result = pf1eApplyCombatantEffect(
        linkedNow.combat,
        client.user,
        linkedNow.member._id,
        request,
      );
      error = result.error ?? "";
      if (result.ops.length) pending.add(client.submit(result.ops));
      return;
    }
    const result = pf1eApplyActorEffect(current, client.user, request);
    error = result.error ?? "";
    if (result.ops.length) pending.add(client.submit(result.ops));
  }

  function toggleEffect(effectId: string, disabled: boolean): void {
    const current = client.store.get("actors", doc._id) as
      ActorDocument | undefined;
    if (!current) {
      error = "Actor is no longer available.";
      return;
    }
    // The combatant home wins when it holds this id (the ticking instance).
    const linkedNow = linkedCombatantDoc();
    if (linkedNow && combatantEffectIds(linkedNow.member).has(effectId)) {
      const result = pf1eSetCombatantEffectDisabled(
        linkedNow.combat,
        client.user,
        linkedNow.member._id,
        effectId,
        disabled,
      );
      error = result.error ?? "";
      if (result.ops.length) pending.add(client.submit(result.ops));
      return;
    }
    const result = pf1eSetActorEffectDisabled(
      current,
      client.user,
      effectId,
      disabled,
    );
    error = result.error ?? "";
    if (result.ops.length) pending.add(client.submit(result.ops));
  }

  function removeEffect(effectId: string): void {
    const current = client.store.get("actors", doc._id) as
      ActorDocument | undefined;
    if (!current) {
      error = "Actor is no longer available.";
      return;
    }
    const linkedNow = linkedCombatantDoc();
    if (linkedNow && combatantEffectIds(linkedNow.member).has(effectId)) {
      const result = pf1eRemoveCombatantEffect(
        linkedNow.combat,
        client.user,
        linkedNow.member._id,
        effectId,
      );
      error = result.error ?? "";
      if (result.ops.length) pending.add(client.submit(result.ops));
      return;
    }
    const result = pf1eRemoveActorEffect(current, client.user, effectId);
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
    {#each ["summary", "attributes", "combat", "weapons", "armor", "features", ...(d.casting ? ["spells"] : []), "effects", ...(sheetRecord(view.authored.creature) ? ["monster"] : []), "details"] as name (name)}
      <button
        type="button"
        class:active={tab === name}
        onclick={() => {
          tab = name as typeof tab;
          error = "";
          spellbookWarning = "";
          castError = "";
          castWarning = "";
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
      <dt>Temporary HP</dt>
      <dd data-temp-hp>
        {d.tempHp} total · separate from current/max HP
        {#if Object.keys(d.tempHpSources).length > 0}
          ({Object.entries(d.tempHpSources).map(([id, v]) => `${id}: ${v}`).join(" · ")})
        {/if}
      </dd>
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
      <dt>Spell slots (0th-9th)</dt>
      <dd data-pf1e-spell-slots>
        {#if slotReadout.view.grantedLevels.length === 0}
          None &mdash; no slots authored for any level
        {:else}
          {slotReadout.view.summary}
          <span class="note"
            >({slotReadout.keyAbility.toUpperCase()}
            {slotReadout.keyAbilityScore ?? "?"}, {slotReadout.mode})</span
          >
        {/if}
      </dd>
      <dt>Fast healing / regeneration</dt>
      <dd>
        {d.fastHealing} / {d.regeneration} (recorded; recovery is not automated)
      </dd>
      <dt>Conditions</dt>
      <dd>{d.conditions.join(", ") || "None"}</dd>
    </dl>
    {#each slotReadout.view.warnings as warning (warning)}
      <p class="note" data-pf1e-spell-slot-warning>{warning}</p>
    {/each}
    <section class="resolve" aria-label="Natural recovery (rest)" data-pf1e-rest>
      <h4>Natural recovery — a night's rest (AoN 170 / CRB p.191)</h4>
      <label
        >Character level
        <input
          bind:value={restLevelOverride}
          placeholder={String(restLevelOf(doc))}
          size="4"
          data-rest-level
        /></label
      >
      <label
        ><input type="checkbox" bind:checked={restBed} data-rest-bed /> Complete bed rest (24h) — 2×</label
      >
      <label
        ><input type="checkbox" bind:checked={restCare} data-rest-care /> Long-term care (Heal) — 2× again</label
      >
      <button
        type="button"
        disabled={!editable}
        onclick={() => doRest()}
        data-rest-submit>Rest &amp; recover</button
      >
      {#if restNote}<p class="note" data-rest-note>{restNote}</p>{/if}
      <p class="note">
        {restLevelOf(doc)} HP per level per night of rest; ability damage heals 1 per affected score per night, 2 per day of complete bed rest; long-term care doubles both. Drain never heals naturally — restoration is its only cure.
      </p>
    </section>
    <section class="resolve" aria-label="Healing" data-pf1e-healing>
      <h4>Healing (CRB p.191 — equal nonlethal removal, never temp HP)</h4>
      <label
        >Amount
        <input bind:value={healAmountRaw} placeholder="e.g. 8" size="4" data-heal-amount /></label
      >
      <button type="button" disabled={!editable} onclick={() => doHealing()} data-heal-submit
        >Heal</button
      >
      {#if healNote}<p class="note" data-heal-note>{healNote}</p>{/if}
      <p class="note">Healing restores hit points up to maximum and removes an equal amount of nonlethal damage (even at full HP); temporary hit points are never restored.</p>
    </section>
    <section class="resolve" aria-label="Temporary hit points" data-pf1e-temp-hp-panel>
      <h4>Temporary hit points (Paizo FAQ — same-source highest, different stack)</h4>
      <label
        >Grant — source
        <input bind:value={tempHpSourceId} placeholder="e.g. aid" size="8" data-temp-grant-id /></label
      >
      <label
        >Amount
        <input bind:value={tempHpAmountRaw} placeholder="e.g. 8" size="4" data-temp-grant-amount /></label
      >
      <button type="button" disabled={!editable} onclick={() => doGrantTempHp()} data-temp-grant-submit>Grant</button>
      <label
        >Expire — source
        <input bind:value={tempHpExpireId} placeholder="e.g. aid" size="8" data-temp-expire-id /></label
      >
      <button type="button" disabled={!editable} onclick={() => doExpireTempHp()} data-temp-expire-submit>Expire</button>
      {#if tempHpNote}<p class="note" data-temp-note>{tempHpNote}</p>{/if}
      <p class="note">Same source overlaps (highest remaining wins); different sources stack. Expiry removes that source only — damage absorbed earlier stays lost.</p>
    </section>
    <section class="resolve" aria-label="Negative levels (energy drain)" data-pf1e-negative-levels>
      <h4>Negative levels — energy drain (AoN 427 / CRB p.562)</h4>
      <p data-negative-levels-readout>
        {#if negativeLevelsTotals.total === 0}
          No negative levels.
        {:else}
          {negativeLevelsTotals.total} total ({negativeLevelsTotals.temporary} temporary, {negativeLevelsTotals.permanent} permanent) — penalties: attack {negativeLevelsPen.attack}, saves {negativeLevelsPen.saves}, HP {negativeLevelsPen.hp}, effective level {negativeLevelsPen.effectiveLevelDelta}{#if negativeLevelsHd > 0 && negativeLevelsTotals.total >= negativeLevelsHd} <span class="warn"> — dead at {negativeLevelsHd} HD (AoN 427)</span>{/if}
        {/if}
        {#if negativeLevelsTotals.issues.length > 0}<span class="warn"> — {negativeLevelsTotals.issues.join(" · ")}</span>{/if}
      </p>
      <div class="resolve" data-negative-inflict>
        <label>Inflict — count <input bind:value={negativeLevelsCountRaw} placeholder="e.g. 1" size="3" data-negative-inflict-count /></label>
        <label>kind <select bind:value={negativeLevelsKind} data-negative-inflict-kind><option value="temporary">temporary (save each day)</option><option value="permanent">permanent (restoration only)</option></select></label>
        <button type="button" disabled={!editable} onclick={() => doInflictNegativeLevels()} data-negative-inflict-submit>Inflict</button>
      </div>
      <div class="resolve" data-negative-save>
        <span>Save — one level</span>
        <label>kind <select bind:value={negativeLevelSaveKind} data-negative-save-kind><option value="temporary">temporary (DC = effect's DC)</option><option value="energy-drain">energy drain (DC 10 + 1/2 racial HD + Cha, 24h; fail → permanent)</option></select></label>
        <label>d20 <input bind:value={negativeLevelDieRaw} placeholder="1–20" size="3" data-negative-save-die /></label>
        <label>Fort <input bind:value={negativeLevelFortRaw} placeholder={String(d.saves.fort)} size="3" data-negative-save-fort /></label>
        <label>DC <input bind:value={negativeLevelDcRaw} placeholder="e.g. 16" size="3" data-negative-save-dc /></label>
        <button type="button" disabled={!editable} onclick={() => doNegativeLevelSave()} data-negative-save-submit>Save</button>
      </div>
      <div class="resolve" data-negative-restore>
        <label>Restoration — count <input bind:value={restorationCountRaw} placeholder="e.g. 1" size="3" data-negative-restore-count /></label>
        <label>kind <select bind:value={restorationKind} data-negative-restore-kind><option value="any">any (temporary first)</option><option value="temporary">temporary</option><option value="permanent">permanent</option></select></label>
        <button type="button" disabled={!editable} onclick={() => doRestoration()} data-negative-restore-submit>Restore</button>
      </div>
      {#if negativeLevelsNote}<p class="note" data-negative-levels-note>{negativeLevelsNote}</p>{/if}
      <p class="note">Per AoN 427/UMR Energy Drain: −1 per level on attacks/saves/skills/ability checks/CMB/CMD, −5 HP (current and total), one level lower for level-dependent variables; death when levels ≥ Hit Dice. Temporary: new save each day at the effect's DC; energy drain: one Fort save after 24h (DC 10 + 1/2 racial HD + Cha), failure makes the level permanent; permanent drain: restoration only. Example DC: vampire 8 HD, Cha +4 → DC {energyDrainSaveDC({ racialHd: 8, chaMod: 4 })}.</p>
    </section>
    <section class="resolve" aria-label="Grit (gunslinger deeds)" data-pf1e-grit>
      <h4>Grit — gunslinger deeds (P09, UC p.135 — Quick Clear, Expert Loading)</h4>
      <p data-grit-readout>Grit {d.grit.current} / {d.grit.max}{#if d.issues.some(i => i.includes("grit."))} <span class="warn"> — {d.issues.filter(i => i.includes("grit."))[0]}</span>{/if}</p>
      <label>Current <input bind:value={gritCurrentRaw} placeholder={String(d.grit.current)} size="3" data-grit-current /></label>
      <label>Max <input bind:value={gritMaxRaw} placeholder={String(d.grit.max)} size="3" data-grit-max /></label>
      <button type="button" disabled={!editable} onclick={() => doGritUpdate()} data-grit-submit>Update grit</button>
      {#if gritNote}<p class="note" data-grit-note>{gritNote}</p>{/if}
      {#if error && (gritCurrentRaw || gritMaxRaw)}<p role="alert">{error}</p>{/if}
      <p class="note">Gunslinger grit pool — spent for Expert Loading (avert a second early misfire while broken: 1 grit prevents the explosion, UC p.135) and Quick Clear (clear a broken firearm as a move action for 1 grit, otherwise a standard action). Load-firearm and Clear-jam buttons are in the Combat panel.</p>
    </section>
    <p class="note">
      Energy resistance is manually adjudicated; temporary HP absorption, source stacking (same-source highest, different stack) and expiration are automated (CRB p.191), healing never restores temp HP. Ability drain never heals naturally — restoration is its only cure. Derived values are read-only.
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
      <p data-pf1e-effective-scores>
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
            {#if manyshotRolls(i).length > 0}
              <!-- Manyshot volley is the first attack of a full-attack action (2 at BAB +6, 3 at +11, 4 at +16) -->
              <button
                type="button"
                data-pf1e-manyshot
                title="First attack of a full-attack volley — remaining iteratives follow as single arrows, so the first bonus is not doubled"
                onclick={() => rollAll(manyshotRolls(i))}
                >Manyshot volley ×{manyshotRolls(i).length} (first attack)</button
              >
              {#if manyshotFullAttackRolls(i).length > 1}
                <button type="button" onclick={() => rollAll(manyshotFullAttackRolls(i))}
                  >Full attack (Manyshot) ×{manyshotFullAttackRolls(i).length}</button
                >
              {/if}
            {:else if group.fullAttack.length > 1}
              <button type="button" onclick={() => rollAll(group.fullAttack)}
                >Full attack ×{group.fullAttack.length}</button
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
          >Flanking
          <select bind:value={resolveFlankingMode} data-pf1e-resolve-flanking>
            <option value="auto"
              >Auto{resolvePosition.ok && resolvePosition.flanked
                ? " (flanked +2)"
                : " (not flanked)"}</option
            >
            <option value="yes">Yes +2</option>
            <option value="no">No</option>
          </select>
        </label>
        <label
          >Cover
          <select bind:value={resolveCoverMode} data-pf1e-resolve-cover>
            <option value="auto"
              >Auto{resolvePosition.defense.cover !== undefined
                ? ` (${resolvePosition.defense.cover})`
                : " (none)"}</option
            >
            <option value="none">None</option>
            {#each COVER_GRADE_OPTIONS as grade (grade)}
              <option value={grade}>{grade}</option>
            {/each}
          </select>
        </label>
        <label
          ><input type="checkbox" bind:checked={resolveCharging} /> Charge +2</label
        >
        <label>Mount movement
          <select bind:value={resolveMountMovement} data-pf1e-mount-movement>
            <option value="stationary">Stationary</option>
            <option value="single">Single move (no penalty)</option>
            <option value="double">Double move (−4 ranged)</option>
            <option value="run">Running (−8 ranged)</option>
          </select>
        </label>
        <label>Mount moved (ft)
          <input bind:value={resolveMountMovedFtRaw} placeholder={String(resolveMountMovedFt)} size="4" data-pf1e-mount-moved-ft />
        </label>
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
            bind:checked={resolvePowerAttack}
            data-pf1e-resolve-power-attack
          /> Power Attack</label
        >
        <label
          ><input
            type="checkbox"
            bind:checked={resolveDeadlyAim}
            data-pf1e-resolve-deadly-aim
          /> Deadly Aim</label
        >
        <label
          ><input
            type="checkbox"
            bind:checked={resolveCombatExpertise}
            data-pf1e-resolve-combat-expertise
          /> Combat Expertise</label
        >
        <label
          ><input
            type="checkbox"
            bind:checked={resolveFightingDefensively}
            data-pf1e-resolve-fighting-defensively
          /> Fighting defensively (−4 / +2 AC)</label
        >
        <label
          ><input
            type="checkbox"
            bind:checked={resolvePointBlank}
            data-pf1e-resolve-point-blank
          /> Point-Blank Shot (≤30 ft)</label
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
          disabled={resolveBusy || manyshotBusy || !resolveTargetId}
          onclick={() => void resolveVsTarget()}
          data-pf1e-resolve-attack
          >{resolveBusy ? "Resolving…" : "Attack"}</button
        >
        {#if manyshotRolls(resolveAttackIndex).length > 0}
          <button
            type="button"
            disabled={resolveBusy || manyshotBusy || !resolveTargetId}
            onclick={() => void resolveManyshotVsTarget()}
            data-pf1e-resolve-manyshot
            title="First attack of a full-attack action — remaining iteratives resolve as single attacks so the first bonus is not doubled"
            >{manyshotBusy
              ? "Resolving Manyshot…"
              : `Resolve Manyshot volley ×${manyshotRolls(resolveAttackIndex).length} (first attack)`}</button
          >
        {/if}
        {#if resolveTargetId}
          <p class="note" data-pf1e-resolve-position>{resolvePositionLine}</p>
        {/if}
        {#if mountedHigher && resolveTargetId}
          <p class="note" data-pf1e-mounted-bonus>
            Mounted: +1 on melee attacks vs the smaller, on-foot target (A.11 —
            the higher-ground bonus)
          </p>
        {/if}
        {#if mountedRangedPenaltyPart !== null && d.attacks[resolveAttackIndex]?.ranged === true && resolveTargetId}
          <p class="note" data-pf1e-mounted-penalty>
            Mounted ranged penalty: {mountedRangedPenaltyPart.label} {mountedRangedPenaltyPart.value} (A.11)
          </p>
        {/if}
        {#if mountedMeleeBar.fullAttack === false && d.attacks[resolveAttackIndex]?.ranged !== true && resolveTargetId}
          <p class="note warn" data-pf1e-mounted-melee-bar>{mountedMeleeBar.reason}</p>
        {/if}
        {#if lanceHint !== null && resolveTargetId}
          <p class="note" data-pf1e-lance-resolve>Lance charge ×{lanceHint.mult}{lanceHint.spirited ? " (Spirited Charge)" : ""} — damage stacks additively with a crit (CRB p.179)</p>
        {/if}
        {#if resolveFirearm !== null && resolveFirearm.ammo !== null && resolveTargetId}
          <p class="note" data-pf1e-firearm-resolve>
            Firearm {d.attacks[resolveAttackIndex]?.name ?? ""} — ammo {resolveFirearm.ammo.loaded}/{resolveFirearm.ammo.capacity}
            {#if resolveFirearm.misfire} · misfire {resolveFirearm.misfire.misfireMinimum} ({resolveFirearm.misfire.generation}{resolveFirearm.misfire.broken ? ", broken" : ""}{resolveFirearm.misfire.magical ? ", magical" : ""}){/if}
            {#if resolveFirearm.canShoot === false} <span class="warn">— empty, cannot shoot (§2.9)</span>{/if}
            {#if resolveFirearm.broken} <span class="warn">— broken (misfire)</span>{/if}
            · grit {resolveFirearm.grit.current}/{resolveFirearm.grit.max}
          </p>
          {#if firearmExplosionHint() !== null}
            <p class="note" data-pf1e-explosion-hint>{firearmExplosionHint()}</p>
          {/if}
        {/if}
        {#if resolveError}<p class="warn" data-pf1e-resolve-error>
            {resolveError}
          </p>{/if}
        {#if resolveWarning}<p class="note" data-pf1e-resolve-warning>
            {resolveWarning}
          </p>{/if}
        {#if resolveFirearm !== null && resolveFirearm.ammo !== null}
          <div class="resolve" data-pf1e-firearm-actions>
            <button type="button" disabled={firearmBusy || !editable} onclick={() => void doFirearmReload()} data-firearm-reload>Reload ({reloadEntry ? `${reloadEntry.category}, provokes ${reloadEntry.provokes}` : "move, provokes"}) — {resolveFirearm.ammo.loaded}/{resolveFirearm.ammo.capacity} → {resolveFirearm.ammo.capacity}</button>
            <label><input type="checkbox" bind:checked={spendGritForClear} data-firearm-spend-grit /> Spend 1 grit for Quick Clear</label>
            <button type="button" disabled={firearmBusy || !editable} onclick={() => void doFirearmClear()} data-firearm-clear>Clear jam — {quickClearPreview.cost} (grit {quickClearPreview.gritSpent ? "1" : "0"}{quickClearPreview.refusal ? ` — ${quickClearPreview.refusal}` : ""})</button>
            <label><input type="checkbox" bind:checked={resolveExpertLoading} data-firearm-expert-loading /> Expert Loading — spend 1 grit to avert explosion on this shot (broken early firearm, UC p.135)</label>
            {#if firearmError}<p class="warn" data-firearm-error>{firearmError}</p>{/if}
            {#if firearmNote}<p class="note" data-firearm-note>{firearmNote}</p>{/if}
            <p class="note">Reloading an early firearm is a move/{reloadEntry?.category ?? "move"} action that provokes (`load-firearm`, Table 7-2, UC p.135 §2.9 — capacity authored on the attack line: {resolveFirearm.ammo.capacity}). A broken firearm must be cleared first: {quickClearPreview.cost} (standard, or move with 1 grit via Quick Clear). Expert Loading (1 grit) averts the explosion on a second early misfire while broken — the resolve flow spends the grit automatically when it averts.</p>
          </div>
          {#if resolveFirearm.misfire !== null}
            <div class="resolve" data-pf1e-explosion-actions>
              <h5>Firearm explosion — 5-ft burst (UC p.135, DC 12 Reflex half)</h5>
              <label>Corner col <input bind:value={explosionCornerColRaw} size="3" data-explosion-col /></label>
              <label>Corner row <input bind:value={explosionCornerRowRaw} size="3" data-explosion-row /></label>
              <label>Damage <input bind:value={explosionDamageRaw} placeholder={d.attacks[resolveAttackIndex]?.damageDice ?? "1d12"} size="8" data-explosion-damage /></label>
              <div data-explosion-targets>
                {#each pf1eTargetActors() as target (target._id)}
                  <label><input type="checkbox" checked={explosionTargetPicks[target._id] === true} onchange={(e) => (explosionTargetPicks = { ...explosionTargetPicks, [target._id]: e.currentTarget.checked })} data-explosion-target={target._id} /> {target.name} (Ref {pf1eSheetView(target).derived.saves.ref})</label>
                {/each}
              </div>
              <button type="button" disabled={explosionBusy || !editable} onclick={() => void doFirearmExplosion()} data-explosion-submit>{explosionBusy ? "Resolving…" : "Resolve explosion burst"}</button>
              {#if explosionError}<p class="warn" data-explosion-error>{explosionError}</p>{/if}
              {#if explosionNote}<p class="note" data-explosion-note>{explosionNote}</p>{/if}
              <p class="note">Burst from the chosen corner covers the 4 squares sharing it ({FIREARM_EXPLOSION_RADIUS_FT} ft). Roll one damage total, each creature Reflex DC {FIREARM_EXPLOSION_DC} for half (floor). Nonmagical firearm destroyed, magical wrecked on explosion.</p>
            </div>
          {/if}
        {/if}
      </div>
      <h4>Combat maneuvers (A.9 — provokes an AoO without the Improved feat)</h4>
      <div class="resolve" data-pf1e-maneuver>
        <label>Maneuver
          <select bind:value={maneuverKind} data-pf1e-maneuver-kind>
            <option value="bull-rush">Bull rush</option>
            <option value="trip">Trip</option>
            <option value="disarm">Disarm</option>
            <option value="sunder">Sunder</option>
            <option value="reposition">Reposition</option>
            <option value="drag">Drag</option>
            <option value="dirty-trick">Dirty trick</option>
            <option value="steal">Steal</option>
            <option value="overrun">Overrun</option>
            <option value="grapple">Grapple</option>
            <option value="grapple-maintain">Grapple — maintain</option>
            <option value="grapple-pin">Grapple — pin</option>
            <option value="grapple-tie-up">Grapple — tie up</option>
            <option value="grapple-escape">Grapple — escape</option>
          </select>
        </label>
        <label>Target
          <select bind:value={maneuverTargetId} data-pf1e-maneuver-target>
            <option value="">— pick a target —</option>
            {#each pf1eTargetActors() as target (target._id)}
              <option value={target._id}>{target.name} (CMD {pf1eSheetView(target).derived.cmd})</option>
            {/each}
          </select>
        </label>
        <label><input type="checkbox" bind:checked={maneuverHasImproved} data-pf1e-maneuver-improved /> Improved (no AoO)</label>
        <label><input type="checkbox" bind:checked={maneuverVerifiable} data-pf1e-maneuver-verifiable /> Commit-reveal</label>
        <button type="button" disabled={maneuverBusy || !maneuverTargetId} onclick={() => void resolveManeuver()} data-pf1e-maneuver-submit>{maneuverBusy ? "Resolving…" : "Maneuver"}</button>
        {#if maneuverError}<p class="warn" data-pf1e-maneuver-error>{maneuverError}</p>{/if}
        {#if maneuverWarning}<p class="note" data-pf1e-maneuver-warning>{maneuverWarning}</p>{/if}
        {#if maneuverTargetId && maneuverPosition.ok === false}<p class="note">{maneuverPosition.reason}</p>{/if}
        <p class="note">Maneuvers spend a standard action and, when they provoke, the defender gets a single melee attack; its damage (if any) penalizes the d20 (AoN 191, 193). Cover/concealment from the scene folds in when readable.</p>
      </div>
      <h4>Aid another (AoN 186 — attack roll vs AC 10)</h4>
      <div class="resolve" data-pf1e-aid>
        <label>Aided ally
          <select bind:value={aidAidedId} data-pf1e-aid-aided>
            <option value="">— pick an ally —</option>
            {#each pf1eTargetActors() as target (target._id)}
              <option value={target._id}>{target.name}</option>
            {/each}
          </select>
        </label>
        <label>Opponent
          <select bind:value={aidOpponentId} data-pf1e-aid-opponent>
            <option value="">— pick the opponent —</option>
            {#each pf1eTargetActors() as target (target._id)}
              <option value={target._id}>{target.name} (CMD {pf1eSheetView(target).derived.cmd})</option>
            {/each}
          </select>
        </label>
        <label>Bonus
          <select bind:value={aidChoice} data-pf1e-aid-choice>
            <option value="attack">Attack +2</option>
            <option value="ac">AC +2</option>
          </select>
        </label>
        <label><input type="checkbox" bind:checked={aidAidedProvokes} data-pf1e-aid-provokes /> Aided action provokes</label>
        <label><input type="checkbox" bind:checked={aidVerifiable} data-pf1e-aid-verifiable /> Commit-reveal</label>
        <button type="button" disabled={aidBusy || !aidAidedId || !aidOpponentId} onclick={() => void resolveAid()} data-pf1e-aid-submit>{aidBusy ? "Aiding…" : "Aid another"}</button>
        {#if aidError}<p class="warn" data-pf1e-aid-error>{aidError}</p>{/if}
        {#if aidWarning}<p class="note" data-pf1e-aid-warning>{aidWarning}</p>{/if}
        <p class="note">Aid spends a standard action and rolls your attack bonus vs AC 10 (natural 1 auto-fails, natural 20 auto-succeeds). Success gives the aided ally +2 circumstance to their next attack or AC vs that opponent. When the aided action itself provokes, the opponent gets the usual interrupt — damage penalizes your check.</p>
      </div>
      <h4>Feint (AoN 195 — Bluff vs 10 + BAB + Wis, or Sense Motive when trained)</h4>
      <div class="resolve" data-pf1e-feint>
        <label>Target
          <select bind:value={feintTargetId} data-pf1e-feint-target>
            <option value="">— pick the opponent —</option>
            {#each pf1eTargetActors() as target (target._id)}
              <option value={target._id}>{target.name}</option>
            {/each}
          </select>
        </label>
        <label>Bluff bonus
          <input bind:value={feintBluffBonusRaw} placeholder={String(d.abilityMods.cha ?? 0)} size="4" data-pf1e-feint-bluff />
        </label>
        <label><input type="checkbox" bind:checked={feintHasImproved} data-pf1e-feint-improved /> Improved Feint (move action)</label>
        <label><input type="checkbox" bind:checked={feintHasGreater} data-pf1e-feint-greater /> Greater Feint (denied until next turn)</label>
        <label><input type="checkbox" bind:checked={feintVerifiable} data-pf1e-feint-verifiable /> Commit-reveal</label>
        <button type="button" disabled={feintBusy || !feintTargetId} onclick={() => void resolveFeint()} data-pf1e-feint-submit>{feintBusy ? "Feinting…" : "Feint"}</button>
        {#if feintError}<p class="warn" data-pf1e-feint-error>{feintError}</p>{/if}
        {#if feintWarning}<p class="note" data-pf1e-feint-warning>{feintWarning}</p>{/if}
        <p class="note">Feint is Bluff vs 10 + the target's BAB + Wis (or their Sense Motive when trained and higher), standard action — move with Improved Feint. Success denies Dex to AC for the next melee attack you make on or before your next turn; Greater Feint keeps the denial until the beginning of your next turn. Vs nonhumanoid −4, animal (Int 1–2) −8, mindless impossible; feint never provokes.</p>
      </div>
      <h4>Mount</h4>
      <div class="resolve" data-pf1e-mount>
        <label
          >Mount
          <select
            data-pf1e-mount-select
            value={currentMount?.actorId ?? ""}
            onchange={(e) =>
              updateMount(
                e.currentTarget.value === "" ? null : e.currentTarget.value,
                currentMount?.combatTrained ?? false,
                currentMount?.saddle ?? "none",
              )}
          >
            <option value="">— none —</option>
            {#each pf1eTargetActors() as m (m._id)}
              <option value={m._id}>{m.name}</option>
            {/each}
          </select>
        </label>
        {#if currentMount !== null && currentMount.actorId !== null}
          <label
            ><input
              type="checkbox"
              data-pf1e-mount-trained
              checked={currentMount.combatTrained}
              onchange={(e) =>
                updateMount(
                  currentMount.actorId,
                  e.currentTarget.checked,
                  currentMount.saddle,
                )}
            /> Combat-trained</label
          >
          <label
            >Saddle
            <select
              data-pf1e-mount-saddle
              value={currentMount.saddle}
              onchange={(e) =>
                updateMount(
                  currentMount.actorId,
                  currentMount.combatTrained,
                  e.currentTarget.value === "military"
                    ? "military"
                    : "none",
                )}
            >
              <option value="none">None</option>
              <option value="military">Military (75% stay mounted)</option>
            </select>
          </label>
        {/if}
      </div>
      {#if mountFootprintInfo !== null}
        <p class="note" data-pf1e-mount-footprint>Mount footprint: {mountFootprintInfo.squares} squares ({mountFootprintInfo.feet} ft) — a Large horse occupies 2×2 (A.11, CRB p.202)</p>
      {/if}
      {#if currentMount !== null && currentMount.actorId !== null}
        <p class="note" data-pf1e-mount-initiative>Initiative is shared: you and the mount act on your initiative count — when charging you must act on the mount's initiative (A.11)</p>
      {/if}
      {#if lanceHint !== null}
        <p class="note" data-pf1e-lance-hint>Lance charge ×{lanceHint.mult} damage on this charge{lanceHint.spirited ? " (Spirited Charge)" : ""} — stacks additively with a critical (×2+×2 ⇒ ×3, ×3+×2 ⇒ ×4, CRB p.179)</p>
      {/if}
      <h4>Ride checks — untrained (A.11, Ride skill)</h4>
      <div class="resolve" data-pf1e-ride>
        <label>Ride mod <input bind:value={rideBonusRaw} placeholder={String(d.abilityMods.dex)} size="3" data-ride-bonus /></label>
        <label>d20 <input bind:value={rideDieRaw} placeholder="1–20" size="3" data-ride-die /></label>
        <button type="button" disabled={rideBusy} onclick={() => doRideCheck("control")} data-ride-control>Control mount DC 20</button>
        <button type="button" disabled={rideBusy} onclick={() => doRideCheck("knees")} data-ride-knees>Guide with knees DC 5</button>
        <button type="button" disabled={rideBusy} onclick={() => doRideCheck("stay")} data-ride-stay>Stay in saddle DC 15</button>
        <label>d100 <input bind:value={rideD100Raw} placeholder="1–100" size="3" data-ride-d100 /></label>
        <button type="button" disabled={rideBusy} onclick={() => doUnconsciousCheck()} data-ride-unconscious>Unconscious {currentMount?.saddle === "military" ? "75%" : "50%"}</button>
        {#if rideError}<p class="warn" data-ride-error>{rideError}</p>{/if}
        {#if rideNote}<p class="note" data-ride-note>{rideNote}</p>{/if}
        {#if rideFallingNote}<p class="warn" data-ride-falling>{rideFallingNote}</p>{/if}
        <p class="note">DC 20 — control an untrained mount (move action) or fail ⇒ full-round (A.11 §2); DC 5 — guide with knees (free hand); DC 15 — stay in saddle when hit (fail ⇒ fall 1d6 host roll). Unconscious: 50% (75% military) per round to stay mounted.</p>
      </div>
      <p class="note">
        Rolls post to chat with their breakdown; resolution rolls attack (+
        confirmation on a threat) and damage publicly and writes hp through the
        sheet's op path. A ranged attack made while threatened provokes first
        (Table 7-2 attack-ranged, D-192).
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
    {#if tab === "features" && featWarnings.length > 0}
      <aside class="warn" data-pf1e-feat-warnings>
        <strong>Prerequisite warnings</strong>
        {#each featWarnings as warning (warning)}<p>{warning}</p>{/each}
        <p class="note">
          Authored feats are retained; warnings do not silently remove them.
        </p>
      </aside>
    {/if}
    {#if tab === "armor" && editable}
      <PF1eAcConversion {doc} user={client.user} onApply={applyAcSource} />
    {/if}
  {:else if tab === "spells"}
    <section class="spellbook" aria-label="Spellbook" data-pf1e-spellbook>
      <h4>
        Spell slots · {spellbook.mode} · keyed to {d.spellKeyAbility.toUpperCase()}
      </h4>
      {#if spellbookWarning}<p role="alert" data-spellbook-warning>
          {spellbookWarning}
        </p>{/if}
      {#if spellbook.ledger.grantedLevels.length === 0}
        <p class="note">No slots authored for any level.</p>
      {:else}
        <table>
          <thead>
            <tr>
              <th scope="col">Level</th>
              <th scope="col">Base</th>
              <th scope="col">Total</th>
              <th scope="col">Spent</th>
              <th scope="col">Remaining</th>
              {#if editable}<th scope="col">Actions</th>{/if}
            </tr>
          </thead>
          <tbody>
            {#each spellbook.ledger.rows.filter((row) => row.total !== null) as row (row.level)}
              <tr data-spell-slot-level={row.level}>
                <td>{row.label}</td>
                <td>{spellbook.budget.levels[row.level]?.base ?? "—"}</td>
                <td data-slot-total>{row.total}</td>
                <td data-slot-spent>{row.spent}</td>
                <td data-slot-remaining>{(row.total ?? 0) - row.spent}</td>
                {#if editable}
                  <td>
                    <button
                      type="button"
                      data-slot-spend={row.level}
                      onclick={() =>
                        updateSpellbook({ kind: "spend", level: row.level })}
                    >
                      Spend
                    </button>
                    <button
                      type="button"
                      data-slot-restore={row.level}
                      disabled={row.spent <= 0}
                      onclick={() =>
                        updateSpellbook({ kind: "restore", level: row.level })}
                    >
                      Restore
                    </button>
                  </td>
                {/if}
              </tr>
            {/each}
          </tbody>
        </table>
      {/if}
      {#each spellbook.ledger.warnings as warning (warning)}
        <p class="note" data-slot-warning>{warning}</p>
      {/each}
      {#if spellbook.mode === "prepared"}
        <h4>Prepared spells</h4>
        {#each spellbook.preparationWarnings as warning (warning)}
          <p class="note" data-prep-warning>{warning}</p>
        {/each}
        {#if editable}
          <form
            aria-label="Prepare a spell"
            onsubmit={(event) => prepareSpell(event)}
          >
            <label
              >Name
              <input
                name="name"
                value={prepareName}
                oninput={(e) => (prepareName = e.currentTarget.value)}
                data-prepare-name
              />
            </label>
            <label
              >Spell level
              <select bind:value={prepareLevel} data-prepare-level>
                {#each Array.from({ length: 10 }, (_, i) => i) as level (level)}
                  <option value={String(level)}>{level}</option>
                {/each}
              </select>
            </label>
            <label
              >Cast slot
              <select bind:value={prepareSlotLevel} data-prepare-slot>
                <option value="">Same as spell level</option>
                {#each Array.from({ length: 10 }, (_, i) => i) as level (level)}
                  <option value={String(level)}>{level}</option>
                {/each}
              </select>
            </label>
            <label
              >Components
              <input
                name="components"
                value={prepareComponents}
                oninput={(e) => (prepareComponents = e.currentTarget.value)}
                placeholder="e.g. V, S, M/DF"
                data-prepare-components
              />
            </label>
            <button type="submit" data-prepare-submit>Prepare</button>
          </form>
        {/if}
        {#if spellbook.prepared.length === 0}
          <p class="note" data-prepared-empty>Nothing prepared yet.</p>
        {:else}
          <ul>
            {#each spellbook.prepared as row, index (`${row.name}#${index}`)}
              <li data-prepared-row={index}>
                <label
                  ><input
                    type="checkbox"
                    checked={row.expended}
                    disabled={!editable}
                    data-prepared-expended={index}
                    onchange={() =>
                      updateSpellbook({ kind: "preparedToggle", index })}
                  />
                  {row.name} · level {row.level}{#if row.slotLevel !== row.level}
                    (cast at {row.slotLevel}){/if}{#if row.components !== ""}
                    · {row.components}{/if}{#if row.expended}
                    — expended{/if}
                </label>
                {#if editable}
                  <button
                    type="button"
                    data-cast-prepared={index}
                    disabled={row.expended}
                    onclick={() => fillCastFromPrepared(index)}
                  >
                    Cast
                  </button>
                  <button
                    type="button"
                    data-prepared-remove={index}
                    onclick={() =>
                      updateSpellbook({ kind: "preparedRemove", index })}
                  >
                    Remove
                  </button>
                {/if}
              </li>
            {/each}
          </ul>
        {/if}
      {/if}
      <h4>Cast at a target</h4>
      {#if castError}<p role="alert" data-cast-error>{castError}</p>{/if}
      {#if castWarning}<p class="note" data-cast-warning>{castWarning}</p>{/if}
      <form
        aria-label="Cast a spell at a target"
        onsubmit={(event) => {
          event.preventDefault();
          void castAtTarget();
        }}
      >
        {#if d.spellMode === "prepared" && castPreparedIndex !== null}
          <p class="note" data-cast-prepared-row>
            Casting prepared row #{castPreparedIndex +
              1}{#if spellbook.prepared[castPreparedIndex]}
              — {spellbook.prepared[castPreparedIndex].name}{/if}: name, level
            and slot are pinned to it.
            <button
              type="button"
              data-cast-clear-row
              onclick={() => {
                castPreparedIndex = null;
              }}>Clear</button
            >
          </p>
        {/if}
        <label
          >Spell
          <input
            value={castName}
            oninput={(e) => (castName = e.currentTarget.value)}
            data-cast-name
            placeholder={d.spellMode === "spontaneous"
              ? "Spell name"
              : "Pick a prepared row, or name a spell"}
          />
        </label>
        <label
          >Spell level
          <select bind:value={castLevel} data-cast-level>
            {#each Array.from({ length: 10 }, (_, i) => i) as lvl (lvl)}
              <option value={String(lvl)}>{lvl}</option>
            {/each}
          </select>
        </label>
        <label
          >Slot
          <select bind:value={castSlot} data-cast-slot>
            <option value="">Same as spell level</option>
            {#each Array.from({ length: 10 }, (_, i) => i) as lvl (lvl)}
              <option value={String(lvl)}>{lvl}</option>
            {/each}
          </select>
        </label>
        <label
          >Target
          <select bind:value={castTargetId} data-cast-target>
            <option value="">—</option>
            {#each pf1eTargetActors() as target (target._id)}
              <option value={target._id}>{target.name}</option>
            {/each}
          </select>
        </label>
        <label
          >Save
          <select bind:value={castSaveType} data-cast-save>
            <option value="fort">Fortitude</option>
            <option value="ref">Reflex</option>
            <option value="will">Will</option>
          </select>
        </label>
        <label
          >Severity
          <select bind:value={castSeverity} data-cast-severity>
            <option value="half">Half</option>
            <option value="negates">Negates</option>
            <option value="none">None (no save)</option>
            <option value="partial">Partial</option>
            <option value="disbelief">Disbelief</option>
          </select>
        </label>
        <label
          >Damage
          <input
            value={castDamage}
            oninput={(e) => (castDamage = e.currentTarget.value)}
            data-cast-damage
            placeholder="NdM, or empty for no damage"
          />
        </label>
        <label
          >Energy
          <select bind:value={castEnergy} data-cast-energy>
            <option value="">Untyped</option>
            <option value="acid">Acid</option>
            <option value="cold">Cold</option>
            <option value="electricity">Electricity</option>
            <option value="fire">Fire</option>
            <option value="sonic">Sonic</option>
          </select>
        </label>
        <label
          >Touch spell
          <select bind:value={castTouch} data-cast-touch>
            <option value="">No touch attack</option>
            <option value="melee">Melee touch attack</option>
            <option value="ranged">Ranged touch attack</option>
          </select>
        </label>
        {#if castTouch !== ""}
          <label
            ><input
              type="checkbox"
              bind:checked={castWilling}
              data-cast-willing
            /> Willing target (automatic touch, no attack roll)</label
          >
        {/if}
        {#if castTouch === "melee"}
          <label
            >Charges held on a miss
            <input
              value={castCharges}
              oninput={(e) => (castCharges = e.currentTarget.value)}
              data-cast-charges
              placeholder="1"
              size="3"
            />
            (one per caster level for spells like <em>chill touch</em>)</label
          >
        {/if}
        <label
          ><input
            type="checkbox"
            bind:checked={castQuickened}
            data-cast-quickened
          />
          Quickened (rides the turn's swift action; no attack of opportunity)</label
        >
        <fieldset data-cast-gate>
          <legend>Casting gate (components &amp; concentration)</legend>
          <label
            >Components
            <input
              value={castComponents}
              oninput={(e) => (castComponents = e.currentTarget.value)}
              placeholder="e.g. V, S, M/DF — empty skips the gate"
              data-cast-components
            />
          </label>
          <label
            >Casting time
            <select bind:value={castTime} data-cast-time>
              <option value="free">Free action</option>
              <option value="swift">Swift action</option>
              <option value="standard">Standard action</option>
              <option value="full-round">Full-round action</option>
              <option value="longer">Longer (1 round+)</option>
            </select>
          </label>
          <label
            ><input
              type="checkbox"
              bind:checked={castCannotSpeak}
              data-cast-cannot-speak
            />
            Cannot speak</label
          >
          <label
            ><input
              type="checkbox"
              bind:checked={castNoFreeHand}
              data-cast-no-free-hand
            />
            No free hand</label
          >
          <label
            ><input
              type="checkbox"
              bind:checked={castNoComponentsInHand}
              data-cast-no-components-in-hand
            />
            Components not in hand</label
          >
          <label
            ><input
              type="checkbox"
              bind:checked={castDeafened}
              data-cast-deafened
            />
            Deafened</label
          >
          <label
            ><input
              type="checkbox"
              bind:checked={castGrappled}
              data-cast-grappled
            />
            Grappling</label
          >
          <label
            ><input
              type="checkbox"
              bind:checked={castPinned}
              data-cast-pinned
            />
            Pinned</label
          >
          <label
            ><input
              type="checkbox"
              bind:checked={castDefensively}
              data-cast-defensively
            />
            Casting defensively (DC 15 + 2× spell level)</label
          >
          <label
            ><input
              type="checkbox"
              bind:checked={castInjured}
              data-cast-injured
            />
            Injured while casting — damage taken
            <input
              value={castInjuredDamage}
              oninput={(e) => (castInjuredDamage = e.currentTarget.value)}
              data-cast-injured-damage
              placeholder="0"
              size="4"
            /></label
          >
          <label
            >Motion
            <select bind:value={castMotion} data-cast-motion>
              <option value="">Steady ground</option>
              <option value="vigorousMotion"
                >Vigorous motion (DC 10 + level)</option
              >
              <option value="violentMotion"
                >Violent motion (DC 15 + level)</option
              >
              <option value="extremelyViolentMotion"
                >Extremely violent motion (DC 20 + level)</option
              >
            </select>
          </label>
          <label
            >Weather
            <select bind:value={castWeather} data-cast-weather>
              <option value="">Calm</option>
              <option value="windRainSleet"
                >Windy rain or sleet (DC 5 + level)</option
              >
              <option value="windHailDebris"
                >Windy hail or dust/debris (DC 10 + level)</option
              >
            </select>
          </label>
          <label
            ><input
              type="checkbox"
              bind:checked={castEntangled}
              data-cast-entangled
            />
            Entangled (DC 15 + spell level)</label
          >
          <label
            ><input
              type="checkbox"
              bind:checked={castContinuous}
              data-cast-continuous
            />
            Taking continuous damage — amount
            <input
              value={castContinuousAmount}
              oninput={(e) => (castContinuousAmount = e.currentTarget.value)}
              data-cast-continuous-amount
              placeholder="0"
              size="4"
            />
            (DC 10 + half + level)</label
          >
          <label
            ><input
              type="checkbox"
              bind:checked={castNonDamaging}
              data-cast-nondamaging
            />
            Distracted by a non-damaging spell — its DC
            <input
              value={castNonDamagingDc}
              oninput={(e) => (castNonDamagingDc = e.currentTarget.value)}
              data-cast-nondamaging-dc
              placeholder="10"
              size="4"
            />
            (DC spell DC + level)</label
          >
          <label
            ><input
              type="checkbox"
              bind:checked={castGrappleCheck}
              data-cast-grapple-check
            />
            Concentrating while grappled or pinned — grappler's CMB
            <input
              value={castGrappleCmb}
              oninput={(e) => (castGrappleCmb = e.currentTarget.value)}
              data-cast-grapple-cmb
              placeholder="0"
              size="4"
            />
            (DC 10 + CMB + level)</label
          >
          <label><input type="checkbox" bind:checked={castMountMovedBeforeAndAfter} data-cast-mount-moved /> Mount moved both before and after casting (DC 10 + level, A.11)</label>
          <label><input type="checkbox" bind:checked={castMountRunning} data-cast-mount-running /> Mount running (DC 15 + level, A.11)</label>
          {#if castMountConcentrationDc !== null}
            <p class="note" data-cast-mount-dc>Mounted casting concentration DC {castMountConcentrationDc} (spell level {castLevel})</p>
          {/if}
        </fieldset>
        <label
          ><input
            type="checkbox"
            bind:checked={castSrOvercome}
            data-cast-sr-overcome
          />
          SR already overcome this round (manual adjudication)</label
        >
        <button
          type="submit"
          data-cast-submit
          disabled={castBusy || castTargetId === ""}
          >{castBusy ? "Casting…" : "Cast"}</button
        >
      </form>
      {#if heldCharge !== null}
        <section class="held-charge" data-held-charge>
          <p>
            Holding the charge: <strong>{heldCharge.name}</strong> (level
            {heldCharge.level}){#if heldChargeCount(heldCharge) > 1},
              <strong data-held-charges
                >{heldChargeCount(heldCharge)} deliveries</strong
              >{/if}
            — deliver it with a melee touch attack, touch a willing friend automatically,
            or it dissipates when another spell is cast.
          </p>
          <button
            type="button"
            data-held-deliver
            disabled={castBusy || castTargetId === ""}
            onclick={() => {
              void deliverHeldCharge(false);
            }}>{castBusy ? "Delivering…" : "Deliver touch"}</button
          >
          <button
            type="button"
            data-held-autotouch
            disabled={castBusy || castTargetId === ""}
            onclick={() => {
              void deliverHeldCharge(true);
            }}>Auto-touch (willing)</button
          >
          <button
            type="button"
            data-held-dismiss
            disabled={castBusy}
            onclick={dismissHeldCharge}>Dissipate</button
          >
          {#if d.attacks.length > 0}
            <p class="note">
              Release through a normal unarmed or natural weapon attack — the
              line's bonus against the target's normal AC; a hit deals the
              weapon's damage and discharges the spell, a miss keeps the charge.
              The caster is not considered armed, so the attack provokes as
              normal.
            </p>
            <label
              >Weapon
              <select bind:value={releaseAttackIndex} data-held-release-weapon>
                {#each d.attacks as attack, i (i)}
                  <option value={i}
                    >{attack.name} ({attack.attackBonus >= 0
                      ? "+"
                      : ""}{attack.attackBonus})</option
                  >
                {/each}
              </select></label
            >
            <button
              type="button"
              data-held-release
              disabled={castBusy || castTargetId === ""}
              onclick={() => {
                void releaseHeldChargeThroughAttack();
              }}>{castBusy ? "Releasing…" : "Release through attack"}</button
            >
          {:else}
            <p class="note">
              Releasing the charge through an unarmed strike or natural weapon
              needs an authored attack line.
            </p>
          {/if}
          <p class="note">
            Touch willing allies: one friend as a standard action (Auto-touch
            above), or pick up to six friends for one full-round action.
          </p>
          <div data-held-ally-list>
            {#each pf1eTargetActors() as target (target._id)}
              <label
                ><input
                  type="checkbox"
                  checked={allyTouchPicks[target._id] === true}
                  onchange={(e) =>
                    (allyTouchPicks = {
                      ...allyTouchPicks,
                      [target._id]: e.currentTarget.checked,
                    })}
                  data-ally-touch-pick={target._id}
                />
                {target.name}</label
              >
            {/each}
          </div>
          <button
            type="button"
            data-held-ally-touch
            disabled={castBusy}
            onclick={() => {
              void touchWillingAllies();
            }}>Touch willing allies (full-round)</button
          >
        </section>
      {/if}
      {#if pendingCast !== null}
        <section class="held-charge" data-pending-cast>
          <p>
            Pending casting: <strong>{pendingCast.name}</strong> (level
            {pendingCast.level}) — it comes into effect just before your next
            turn; if concentration breaks before then, the spell is lost.
          </p>
          <button
            type="button"
            data-pending-complete
            disabled={castBusy}
            onclick={() => {
              void completePendingCast();
            }}>{castBusy ? "Completing…" : "Complete the casting"}</button
          >
          <label
            >Interruption damage
            <input
              value={pendingDisruptDamage}
              oninput={(e) => (pendingDisruptDamage = e.currentTarget.value)}
              data-pending-disrupt-damage
              placeholder="0"
              size="4"
            /></label
          >
          <button
            type="button"
            data-pending-disrupt
            disabled={castBusy}
            onclick={() => {
              void checkPendingDisruption();
            }}>Concentration check</button
          >
          <button
            type="button"
            data-pending-abandon
            disabled={castBusy}
            onclick={abandonPendingCast}>Lose the spell</button
          >
        </section>
      {/if}
      <p class="note">
        Spending and preparation are daily state; resting/recovery automation
        arrives with P7. Overuse is warned, not blocked (C04). Casting spends
        the slot and expends the prepared row, rolls the target's save and any
        SR check host-side, and writes the target's HP. A declared Components
        line runs the C03a gate (D-157): legality, armour arcane spell failure
        (arcane tradition, authored <code>armor.spellFailure</code>), deafened
        spoilage and declared concentration checks — a failed check loses the
        spell and still spends it. A Touch spell (D-158) rolls the touch attack
        as part of the cast; a missed melee touch holds the charge for later
        delivery, a missed ranged touch spends the spell. A held charge (D-162)
        can be delivered by touch, auto-touched onto willing allies (one
        standard action, or up to six friends as a full-round action), or
        released through a normal unarmed/natural weapon attack; a multi-touch
        spell holds one charge per declared count. Swift and quickened casts
        spend the turn's swift action and never provoke an attack of opportunity
        (D-163); other metamagic feats, attacks of opportunity against
        ranged-touch casters and area/target-count payloads (C05) are not yet
        part of this single-target flow.
      </p>
    </section>
  {:else if tab === "effects"}
    <p class="note" data-pf1e-effective-scores>
      Effective scores: {Object.entries(d.abilities)
        .map(([key, score]) => `${key.toUpperCase()} ${score}`)
        .join(" · ")}
    </p>
    <PF1eEffectsTab
      effects={view.effects}
      effectErrors={view.effectErrors}
      {editable}
      linkedCombatant={linked.combat !== null && linked.combatantId !== null}
      onApply={applyEffect}
      onToggle={toggleEffect}
      onRemove={removeEffect}
    />
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
          tempHpSources: view.authored.tempHpSources,
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
    font-size: 0.875rem;
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
