/**
 * P4/E01 — the effect apply/persist path (`pf1eEffectOps`) and its two consumers
 * that had no wiring before: action denies (`actions.ts`) and damage-roll boosts
 * (`rollData.ts`). The stacking/penalty/suppression mathematics itself is P0's
 * `resolveEffects` (pf1eEffects.test.ts) — here it is exercised end-to-end through
 * real documents and Ops, including the plan's expiry-revert acceptance.
 */
import { describe, expect, test } from "vitest";
import { activeEffects, nextTurn, startCombat } from "../../src/core/combat";
import type {
  ActorDocument,
  CombatDocument,
  CombatantDocument,
  Json,
} from "../../src/core/documents";
import type { PermissionUser } from "../../src/core/ownership";
import { deriveFromDocuments } from "../../src/packages/pf1e/actor";
import { actionRefusal, spendAction } from "../../src/packages/pf1e/actions";
import {
  buildEffectDoc,
  combinedTacticalEffects,
  MAX_EFFECTS,
  pf1eApplyActorEffect,
  pf1eApplyCombatantEffect,
  pf1eRemoveActorEffect,
  pf1eRemoveCombatantEffect,
  pf1eSetActorEffectDisabled,
  pf1eSetCombatantEffectDisabled,
  resolveTacticalEffects,
} from "../../src/packages/pf1e/effectOps";
import { pf1eAttackRollGroups } from "../../src/packages/pf1e/rollData";
import { spendCombatantAction } from "../../src/packages/pf1e/combatState";
import { pf1eSheetView } from "../../src/ui/sheets/pf1eSheetModel";

const gm: PermissionUser = { id: "gm", role: "GM" };
const outsider: PermissionUser = { id: "mallory", role: "PLAYER" };

function actor(str = 16): ActorDocument {
  return {
    _id: "fighter",
    type: "actor",
    name: "Fighter",
    ownership: { default: 2, player: 3 },
    flags: {},
    system: { pf1e: { abilities: { str } } },
    items: [],
    effects: [],
  };
}

function combatant(
  id: string,
  initiative: number | null,
  actorId: string | null = null,
): CombatantDocument {
  return {
    _id: id,
    type: "combatant",
    name: id,
    ownership: { default: 1 },
    flags: {},
    system: {},
    tokenId: null,
    actorId,
    initiative,
    hidden: false,
    defeated: false,
  };
}

function combat(...cs: CombatantDocument[]): CombatDocument {
  return {
    _id: "enc",
    type: "combat",
    name: "fight",
    ownership: { default: 1 },
    flags: {},
    system: {},
    round: 0,
    turn: 0,
    combatants: cs,
  };
}

/** Read an actor's embedded effects the way `pf1eSheetView` does (validated, not raw). */
function readEffects(a: ActorDocument) {
  return combinedTacticalEffects(a, null, null).effects;
}

/** The `effects` array an apply/toggle/remove op carries in its diff. */
function diffEffects(
  op: Record<string, Json> | undefined,
  what: string,
): ActorDocument["effects"] {
  const d = ensure(op, what).diff as unknown as {
    effects: ActorDocument["effects"];
  };
  return ensure(d.effects, "diff effects");
}

/** Guard instead of `!` — the lint forbids non-null assertions. */
function ensure<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined)
    throw new Error(`missing fixture value: ${what}`);
  return value;
}

const bullsStrength = {
  name: "Bull's Strength",
  payload: {
    mods: [
      { key: "ability.str" as const, type: "enhancement" as const, value: 4 },
    ],
    ttl: { unit: "minute" as const, value: 1, perLevel: true },
    source: { kind: "spell" as const, level: 2 },
  },
};

describe("pf1eEffectOps — the apply/persist path (E01)", () => {
  test("buildEffectDoc seeds both flag scopes and never uses `changes`", () => {
    const doc = buildEffectDoc({ id: "eff-1", ...bullsStrength });
    expect(doc.ok).toBe(true);
    if (!doc.ok) return;
    expect(doc.value).toMatchObject({
      _id: "eff-1",
      type: "effect",
      name: "Bull's Strength",
      changes: [],
      disabled: false,
    });
    // 1 minute/level at CL 2 = 20 ticks (1 minute = 10 rounds, A.1) — core's
    // per-turn tick counts what the spell text says, seeded once here.
    expect((doc.value.flags.core as Record<string, Json>).duration).toBe(20);
    // Validation normalizes the ttl (adds the default `endsOn: "own-turn"`).
    expect(doc.value.flags.pf1e).toEqual({
      ...bullsStrength.payload,
      ttl: { ...bullsStrength.payload.ttl, endsOn: "own-turn" },
    });
  });

  test("buildEffectDoc requires a name and validates the payload", () => {
    expect(buildEffectDoc({ name: "  ", payload: {} }).ok).toBe(false);
    const bad = buildEffectDoc({
      name: "Broken",
      payload: { mods: [{ key: "nope" as never, type: "morale", value: 1 }] },
    });
    expect(bad.ok).toBe(false);
  });

  test("actor apply lands in `actor.effects` and the derivation reads it; non-owners are refused", () => {
    const a = actor();
    const gmResult = pf1eApplyActorEffect(a, gm, {
      id: "bs",
      ...bullsStrength,
    });
    expect(gmResult.error).toBeNull();
    const applied = { ...a, effects: [...a.effects] };
    const op = ensure(gmResult.ops[0], "actor apply op");
    expect(op.ref).toEqual({ coll: "actors", id: "fighter" });
    applied.effects = [
      ...applied.effects,
      ensure(
        diffEffects(gmResult.ops[0], "actor apply op").at(-1),
        "applied effect",
      ),
    ];
    expect(applied.effects).toHaveLength(1);
    // The derivation takes the *read* effect list — the sheet model reads and
    // validates the embedded documents first (the same call `pf1eSheetView` makes).
    expect(
      deriveFromDocuments({ actor: applied, effects: readEffects(applied) })
        .abilities.str,
    ).toBe(20);

    const deniedWrite = pf1eApplyActorEffect(a, outsider, {
      id: "bs",
      ...bullsStrength,
    });
    expect(deniedWrite.ops).toHaveLength(0);
    expect(deniedWrite.error).toMatch(/do not own/);
  });

  test("the plan's stacking fixture through the real apply path: +2 enhancement and +2 insight add; two +2 enhancement do not", () => {
    const a = actor(10);
    let effects = a.effects;
    for (const [id, type] of [
      ["e1", "enhancement"],
      ["e2", "insight"],
    ] as const) {
      const r = pf1eApplyActorEffect({ ...a, effects }, gm, {
        id,
        name: `${type} buff`,
        payload: { mods: [{ key: "ability.str", type, value: 2 }] },
      });
      expect(r.error).toBeNull();
      effects = diffEffects(r.ops[0], "stack op") as typeof effects;
    }
    const afterTwo = { ...a, effects };
    expect(
      deriveFromDocuments({ actor: afterTwo, effects: readEffects(afterTwo) })
        .abilities.str,
    ).toBe(14);
    const r3 = pf1eApplyActorEffect({ ...a, effects }, gm, {
      id: "e3",
      name: "another enhancement",
      payload: {
        mods: [{ key: "ability.str", type: "enhancement", value: 2 }],
      },
    });
    const withThird = {
      ...a,
      effects: diffEffects(r3.ops[0], "third op") as typeof effects,
    };
    // Same type to the same key keeps the best (+2), it never stacks to +4.
    expect(
      deriveFromDocuments({ actor: withThird, effects: readEffects(withThird) })
        .abilities.str,
    ).toBe(14);
  });

  test("duplicate ids, caps and malformed lists are refused with named errors", () => {
    const a = actor();
    const first = pf1eApplyActorEffect(a, gm, {
      id: "same",
      name: "A",
      payload: {},
    });
    expect(first.error).toBeNull();
    const withOne = {
      ...a,
      effects: [
        ...a.effects,
        ensure(diffEffects(first.ops[0], "first op")[0], "first effect"),
      ],
    };
    const second = pf1eApplyActorEffect(withOne, gm, {
      id: "same",
      name: "B",
      payload: {},
    });
    expect(second.error).toMatch(/already exists/);
    expect(second.ops).toHaveLength(0);

    const full = actor();
    full.effects = Array.from({ length: MAX_EFFECTS }, (_, i) => ({
      _id: `e${i}`,
      type: "effect" as const,
      name: `e${i}`,
      ownership: { default: 0 },
      flags: {},
      system: {},
      changes: [],
      disabled: false,
    }));
    expect(
      pf1eApplyActorEffect(full, gm, { name: "over", payload: {} }).error,
    ).toMatch(/Too many effects/);
  });

  test("suppress (disable) reverts the derivation; re-enable restores; remove deletes", () => {
    const a = actor();
    const applied = pf1eApplyActorEffect(a, gm, { id: "bs", ...bullsStrength });
    let current: ActorDocument = {
      ...a,
      effects: diffEffects(applied.ops[0], "apply op"),
    };
    expect(
      deriveFromDocuments({ actor: current, effects: readEffects(current) })
        .abilities.str,
    ).toBe(20);

    const suppressed = pf1eSetActorEffectDisabled(current, gm, "bs", true);
    current = {
      ...current,
      effects: diffEffects(suppressed.ops[0], "suppress op"),
    };
    // Suppression is the P0 resolver's disabled flag — contributes nothing.
    expect(
      deriveFromDocuments({ actor: current, effects: readEffects(current) })
        .abilities.str,
    ).toBe(16);
    expect(current.effects[0]?.disabled).toBe(true);

    const restored = pf1eSetActorEffectDisabled(current, gm, "bs", false);
    current = {
      ...current,
      effects: diffEffects(restored.ops[0], "restore op"),
    };
    expect(
      deriveFromDocuments({ actor: current, effects: readEffects(current) })
        .abilities.str,
    ).toBe(20);

    const removed = pf1eRemoveActorEffect(current, gm, "bs");
    current = { ...current, effects: diffEffects(removed.ops[0], "remove op") };
    expect(current.effects).toHaveLength(0);
    expect(
      deriveFromDocuments({ actor: current, effects: readEffects(current) })
        .abilities.str,
    ).toBe(16);

    expect(pf1eRemoveActorEffect(current, gm, "ghost").error).toMatch(
      /not on this actor/,
    );
    expect(
      pf1eSetActorEffectDisabled(current, outsider, "bs", true).error,
    ).toMatch(/do not own/);
  });

  test("combatant apply writes flags.core.effects exactly as core's badge/tick path reads", () => {
    const enc = combat(combatant("a", 20, "fighter"), combatant("b", 15));
    const result = pf1eApplyCombatantEffect(enc, gm, "a", {
      id: "bs",
      ...bullsStrength,
    });
    expect(result.error).toBeNull();
    expect(result.combat).not.toBeNull();
    const member = ensure(
      ensure(result.combat, "applied combat").combatants.find(
        (c) => c._id === "a",
      ),
      "combatant a",
    );
    const effects = (member.flags.core as Record<string, Json>)
      .effects as Record<string, Json>;
    expect(Object.keys(effects)).toEqual(["bs"]);
    // The badge path (CombatPanel) reads the very same map.
    expect(
      activeEffects(ensure(result.combat, "combat")).map((e) => e.id),
    ).toEqual(["bs"]);
    expect(activeEffects(ensure(result.combat, "combat"))[0]?.duration).toBe(
      20,
    );

    const op = ensure(result.ops[0], "combatant apply op");
    expect(op.ref).toEqual({ coll: "combats", id: "enc" });
    expect(Object.keys(op.diff as object)).toEqual(["combatants"]);

    expect(
      pf1eApplyCombatantEffect(enc, gm, "ghost", { name: "x", payload: {} })
        .error,
    ).toMatch(/not part of this encounter/);
    expect(
      pf1eApplyCombatantEffect(enc, outsider, "a", { name: "x", payload: {} })
        .error,
    ).toMatch(/cannot update this encounter/);
  });

  test("expiry-revert acceptance: the tick consumes the owner's duration only, and expiry restores the base derivation", () => {
    const a = actor();
    const enc = combat(combatant("a", 20, "fighter"), combatant("b", 15));
    // A 2-round personal effect on combatant a: core ticks at the owner's turn
    // end (the "ends at the beginning of your next turn" convention), so the
    // first tick lands when the caster's own turn ends.
    const applied = pf1eApplyCombatantEffect(enc, gm, "a", {
      id: "bs",
      name: "Bull's Strength",
      payload: {
        mods: [{ key: "ability.str", type: "enhancement", value: 4 }],
        ttl: { unit: "round", value: 2 },
      },
    });
    expect(applied.error).toBeNull();
    const doc = (
      ensure(ensure(applied.combat, "combat").combatants[0], "combatant a")
        .flags.core as Record<string, Json>
    ).effects as Record<string, Json>;
    expect(
      (doc.bs as { flags: { core: { duration: number } } }).flags.core.duration,
    ).toBe(2);

    const live = { ...a, effects: [] };
    const read = (c: CombatDocument) =>
      combinedTacticalEffects(a, c, "a").effects;
    const derivedStr = (c: CombatDocument) =>
      deriveFromDocuments({ actor: live, effects: read(c) }).abilities.str;

    const started = startCombat(ensure(applied.combat, "combat"));
    expect(derivedStr(started.combat)).toBe(20);

    // Ending a's turn ticks a's effect (2→1); it stays live.
    const t1 = nextTurn(started.combat);
    expect(derivedStr(t1.combat)).toBe(20);
    expect(t1.expired).toHaveLength(0);
    // Ending b's turn ticks b — a's effect untouched.
    const t2 = nextTurn(t1.combat);
    expect(derivedStr(t2.combat)).toBe(20);
    expect(t2.expired).toHaveLength(0);
    // Ending a's turn again (round 2): the last tick lands and the effect drops.
    const t3 = nextTurn(t2.combat);
    expect(t3.expired).toEqual([{ combatantId: "a", effectId: "bs" }]);
    expect(read(t3.combat)).toHaveLength(0);
    expect(derivedStr(t3.combat)).toBe(16);
  });

  test("combined read: the combatant copy shadows an embedded twin; rejected payloads are surfaced, never silent", () => {
    const a = actor(10);
    a.effects = [
      {
        _id: "bs",
        type: "effect",
        name: "Embedded (stale) copy",
        ownership: { default: 0 },
        flags: {
          pf1e: {
            mods: [{ key: "ability.str", type: "enhancement", value: 2 }],
          },
        },
        system: {},
        changes: [],
        disabled: false,
      },
      {
        _id: "broken",
        type: "effect",
        name: "Broken",
        ownership: { default: 0 },
        flags: { pf1e: { nope: true } },
        system: {},
        changes: [],
        disabled: false,
      },
    ];
    const enc = combat(combatant("a", 20, "fighter"));
    const applied = pf1eApplyCombatantEffect(enc, gm, "a", {
      id: "bs",
      name: "Combat copy",
      payload: {
        mods: [{ key: "ability.str", type: "enhancement", value: 4 }],
      },
    });

    const merged = combinedTacticalEffects(a, applied.combat, "a");
    expect(merged.effects.map((e) => e.id).sort()).toEqual(["bs"]);
    expect(merged.effects[0]?.name).toBe("Combat copy");
    expect(merged.rejected.map((r) => r.id)).toEqual(["broken"]);
    expect(
      deriveFromDocuments({ actor: a, effects: merged.effects }).abilities.str,
    ).toBe(14);

    // Without an encounter the embedded home is the only truth.
    const alone = combinedTacticalEffects(a, null, null);
    expect(alone.effects[0]?.name).toBe("Embedded (stale) copy");
  });

  test("pf1eSheetView reads the combatant home through the ctx and reports it", () => {
    const a = actor(10);
    const enc = combat(combatant("a", 20, "fighter"));
    const applied = pf1eApplyCombatantEffect(enc, gm, "a", {
      id: "bs",
      name: "Bull's Strength",
      payload: {
        mods: [{ key: "ability.str", type: "enhancement", value: 4 }],
      },
    });
    const withCtx = pf1eSheetView(a, {
      combat: applied.combat,
      combatantId: "a",
    });
    expect(withCtx.derived.abilities.str).toBe(14);
    expect(withCtx.effects).toHaveLength(1);
    expect(pf1eSheetView(a).derived.abilities.str).toBe(10);
  });

  test("combatant toggle/remove mirror the actor path with the same authorization gate", () => {
    const enc = combat(combatant("a", 20, "fighter"));
    const applied = pf1eApplyCombatantEffect(enc, gm, "a", {
      id: "bs",
      ...bullsStrength,
    });
    const suppressed = pf1eSetCombatantEffectDisabled(
      ensure(applied.combat, "combat"),
      gm,
      "a",
      "bs",
      true,
    );
    const member = ensure(
      ensure(suppressed.combat, "suppressed combat").combatants[0],
      "member",
    );
    expect(
      (
        (
          (member.flags.core as Record<string, Json>).effects as Record<
            string,
            Json
          >
        ).bs as { disabled: boolean }
      ).disabled,
    ).toBe(true);
    const removed = pf1eRemoveCombatantEffect(
      ensure(suppressed.combat, "suppressed"),
      gm,
      "a",
      "bs",
    );
    const after = ensure(
      ensure(removed.combat, "removed combat").combatants[0],
      "member",
    );
    expect((after.flags.core as Record<string, Json>).effects).toEqual({});
    expect(
      pf1eRemoveCombatantEffect(
        ensure(removed.combat, "combat"),
        outsider,
        "a",
        "x",
      ).error,
    ).toMatch(/cannot update this encounter/);
    expect(
      pf1eRemoveCombatantEffect(
        ensure(removed.combat, "combat"),
        gm,
        "a",
        "ghost",
      ).error,
    ).toMatch(/not on this combatant/);
  });

  test("resolved deny tokens gate the action ledger and the combatant spend", () => {
    const enc = combat(combatant("a", 20, "fighter"));
    const applied = pf1eApplyCombatantEffect(enc, gm, "a", {
      id: "slow",
      name: "Slowed stance",
      payload: { denies: ["charge", "full-attack", "aoo"] },
    });
    const resolved = resolveTacticalEffects(
      combinedTacticalEffects(actor(), applied.combat, "a").effects,
    );
    const denied = resolved.denies;
    expect(denied.has("charge")).toBe(true);

    const ledger = {
      standardUsed: false,
      moveUsed: false,
      swiftUsed: false,
      swiftReserved: false,
      fiveFootStepUsed: false,
      movementFt: 0,
      fullRoundPending: null,
      restriction: "none" as const,
    };
    expect(
      actionRefusal(
        ledger,
        { kind: "start-full-round", action: "charge" },
        denied,
      ),
    ).toMatch(/denies this action \(charge\)/);
    expect(
      actionRefusal(ledger, { kind: "standard", action: "charge" }, denied),
    ).toMatch(/denies this action \(charge\)/);
    expect(
      actionRefusal(
        ledger,
        { kind: "full-round", action: "full-attack" },
        denied,
      ),
    ).toMatch(/denies this action \(full-attack\)/);
    // Without a deny token the same spends are legal.
    expect(
      actionRefusal(ledger, { kind: "full-round", action: "full-attack" }),
    ).toBeNull();
    // "aoo" is inert here — the interrupt queue (P6) consumes it.
    expect(
      spendAction(ledger, { kind: "standard", action: "attack-melee" }, denied)
        .ok,
    ).toBe(true);
    expect(
      spendAction(
        ledger,
        { kind: "start-full-round", action: "charge" },
        denied,
      ).ok,
    ).toBe(false);
    const refused = spendCombatantAction(
      ensure(applied.combat, "combat"),
      "a",
      { kind: "start-full-round", action: "charge" },
      denied,
    );
    expect(refused.ok).toBe(false);
    const allowed = spendCombatantAction(
      ensure(applied.combat, "combat"),
      "a",
      { kind: "standard", action: "attack-melee" },
      denied,
    );
    expect(allowed.ok).toBe(true);
  });
});

describe("pf1eAttackRollGroups — effect damage boosts (E01)", () => {
  test("riders extend the damage roll and are named, but are never multiplied on a crit", () => {
    const derived = {
      attacks: [
        {
          name: "Longsword",
          attackBonuses: [9],
          damageDice: "1d8",
          damageBonus: 4,
          damageType: "slashing",
          critThreatMin: 19,
          critMultiplier: 2,
          explain: "9 = BAB bonus",
        },
      ],
      baseAttack: 6,
    } as unknown as Parameters<typeof pf1eAttackRollGroups>[0];
    const groups = pf1eAttackRollGroups(derived, {
      effectBoosts: [
        { boost: { dice: 1, sides: 6, energy: "fire" }, from: "Flaming" },
      ],
    });
    expect(groups).toHaveLength(1);
    expect(groups[0]?.damage?.formula).toBe("1d8 + 4 + 1d6");
    expect(groups[0]?.damage?.notes).toEqual(["+1d6 fire damage (Flaming)"]);
    // CRB p.179: extra damage dice are not multiplied — the crit formula is the
    // weapon's own groups, with the caveat surfaced as a note.
    expect(groups[0]?.critDamage?.formula).toBe("1d8 + 4 + 1d8 + 4");
    expect(groups[0]?.critDamage?.notes).toEqual([
      "effect damage bonuses are not multiplied on a critical",
    ]);
  });

  test("a static-only boost and a boost on a dice-less line both land", () => {
    const derived = {
      attacks: [
        {
          name: "Longsword",
          attackBonuses: [9],
          damageDice: "1d8",
          damageBonus: 4,
          damageType: "slashing",
          critThreatMin: 19,
          critMultiplier: 2,
          explain: "9 = BAB bonus",
        },
      ],
      baseAttack: 6,
    } as unknown as Parameters<typeof pf1eAttackRollGroups>[0];
    const groups = pf1eAttackRollGroups(derived, {
      effectBoosts: [{ boost: { bonus: 2 }, from: "Bless weapon" }],
    });
    expect(groups[0]?.damage?.formula).toBe("1d8 + 4 + 2");
    expect(groups[0]?.damage?.notes).toEqual(["+2 damage (Bless weapon)"]);

    const flat = {
      attacks: [
        {
          name: "Longsword",
          attackBonuses: [9],
          damageDice: "",
          damageBonus: 3,
          damageType: "slashing",
          critThreatMin: 19,
          critMultiplier: 2,
          explain: "9 = BAB bonus",
        },
      ],
      baseAttack: 6,
    } as unknown as Parameters<typeof pf1eAttackRollGroups>[0];
    const flatGroups = pf1eAttackRollGroups(flat, {
      effectBoosts: [{ boost: { bonus: 2 }, from: "Effect" }],
    });
    expect(flatGroups[0]?.damage?.formula).toBe("3 + 2");
    // No boosts ⇒ no notes, and the formulas are exactly the D-139 shapes.
    const plain = pf1eAttackRollGroups(derived);
    expect(plain[0]?.damage?.formula).toBe("1d8 + 4");
    expect(plain[0]?.damage?.notes).toEqual([]);
    expect(plain[0]?.critDamage?.notes).toEqual([]);
  });
});
