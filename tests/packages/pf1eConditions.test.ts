/**
 * P4/E03 — the mathematical condition library. Every payload was transcribed
 * from the canonical conditions text (fetched for this slice; the A.14 modifier
 * table agrees). The suite's spine is the E03 clause "do not conflate conditions
 * with different consequences": each severity/adjacent pair gets a
 * discriminating fixture, and the typed stacking proves the fear-family
 * morale classification (fear does not stack with fear; it stacks with untyped).
 */
import { describe, expect, test } from "vitest";
import type { ActorDocument, Json } from "../../src/core/documents";
import { deriveFromDocuments } from "../../src/packages/pf1e/actor";
import {
  PF1E_CONDITION_NAMES,
  conditionRefusalFor,
  pf1eConditionDef,
  pf1eConditionPayload,
  pf1eConditionRequest,
} from "../../src/packages/pf1e/conditions";
import { buildEffectDoc } from "../../src/packages/pf1e/effectOps";
import {
  readTacticalEffects,
  resolveEffects,
} from "../../src/packages/pf1e/effects";

/** Str 16 / Dex 14, BAB +6, one melee line — the shared derivation fixture. */
function actor(): ActorDocument {
  return {
    _id: "duelist",
    type: "actor",
    name: "Duelist",
    ownership: { default: 2 },
    flags: {},
    system: {
      pf1e: {
        abilities: { str: 16, dex: 14, con: 12, int: 10, wis: 10, cha: 10 },
        baseAttack: 6,
        hp: 30,
        hpMax: 30,
        attacks: [
          {
            name: "Rapier",
            damageDice: "1d6",
            damageBonus: 3,
            damageType: "piercing",
            critThreatMin: 20,
            critMultiplier: 2,
          },
        ],
      },
    },
    items: [],
    effects: [],
  };
}

/** Narrow the Result union: a test failure names the condition. */
function payloadOf(name: string) {
  const r = pf1eConditionPayload(name);
  if (!r.ok) throw new Error(`fixture: ${name}: ${r.error}`);
  return r.value;
}

/** Narrow the def lookup the same way. */
function defOf(name: string) {
  const def = pf1eConditionDef(name);
  if (def === null) throw new Error(`fixture: no condition ${name}`);
  return def;
}

describe("pf1eConditions — coverage and validation (E03)", () => {
  test("the library covers the 26 canonical combat conditions plus Staggered", () => {
    expect(PF1E_CONDITION_NAMES).toHaveLength(27);
    for (const required of [
      "Flat-Footed",
      "Prone",
      "Blinded",
      "Invisible",
      "Entangled",
      "Grappled",
      "Pinned",
      "Stunned",
      "Dazed",
      "Dazzled",
      "Shaken",
      "Frightened",
      "Panicked",
      "Fatigued",
      "Exhausted",
      "Sickened",
      "Nauseated",
      "Helpless",
      "Cowering",
      "Disabled",
      "Dying",
      "Stable",
      "Unconscious",
      "Paralyzed",
      "Petrified",
      "Confused",
      "Staggered",
    ])
      expect(PF1E_CONDITION_NAMES).toContain(required);
  });

  test("every payload survives the P0 validator through the real doc builder", () => {
    for (const name of PF1E_CONDITION_NAMES) {
      const request = pf1eConditionRequest(name);
      expect(request.ok, name).toBe(true);
      if (!request.ok) continue;
      const doc = buildEffectDoc(request.value);
      expect(doc.ok, name).toBe(true);
      if (!doc.ok) continue;
      expect(doc.value.name, name).toBe(name);
      expect(
        (doc.value.flags.pf1e as Record<string, Json>).condition,
        name,
      ).toBe(name);
    }
  });

  test("unknown names are named errors, and lookup is case-insensitive", () => {
    expect(pf1eConditionPayload("Exhausted").ok).toBe(true);
    expect(pf1eConditionPayload("exhausted").ok).toBe(true);
    const dizzy = pf1eConditionPayload("Dizzy");
    expect(dizzy.ok).toBe(false);
    if (dizzy.ok) throw new Error("fixture: Dizzy must fail");
    expect(dizzy.error).toMatch(/unknown condition "Dizzy"/);
    expect(pf1eConditionDef("  prone ")).not.toBeNull();
  });

  test("every note is a non-empty string and every def carries a summary", () => {
    for (const def of PF1E_CONDITIONS_REEXPORT()) {
      expect(def.summary.length).toBeGreaterThan(20);
      for (const note of def.notes) expect(note.length).toBeGreaterThan(10);
    }
  });
});

// A tiny local re-export shim so the test does not import the const twice.
import { PF1E_CONDITIONS } from "../../src/packages/pf1e/conditions";
function PF1E_CONDITIONS_REEXPORT() {
  return PF1E_CONDITIONS;
}

describe("pf1eConditions — exact mechanics (severity pairs are not conflated)", () => {
  test("Fatigued −2 Str/Dex vs Exhausted −6 Str/Dex; both deny run/charge", () => {
    const fatigued = payloadOf("Fatigued");
    const exhausted = payloadOf("Exhausted");
    expect(fatigued.mods).toEqual([
      { key: "ability.str", type: "untyped", value: -2, source: "fatigued" },
      { key: "ability.dex", type: "untyped", value: -2, source: "fatigued" },
    ]);
    expect(exhausted.mods).toEqual([
      { key: "ability.str", type: "untyped", value: -6, source: "exhausted" },
      { key: "ability.dex", type: "untyped", value: -6, source: "exhausted" },
    ]);
    expect(fatigued.denies).toEqual(["run", "charge"]);
    expect(exhausted.denies).toEqual(["run", "charge"]);
    // Neither fear, neither mind-affecting.
    expect(pf1eConditionDef("Fatigued")?.mindAffecting).toBe(false);
    expect(pf1eConditionDef("Fatigued")?.fear).toBe(false);
  });

  test("Shaken vs Frightened vs Panicked: fear is typed morale and Panicked does not penalize attack", () => {
    const shaken = payloadOf("Shaken");
    const frightened = payloadOf("Frightened");
    const panicked = payloadOf("Panicked");
    // Shaken and Frightened share the numbers (they differ in the forced flee, a note).
    expect(shaken?.mods).toEqual([
      { key: "attack", type: "morale", value: -2, source: "shaken" },
      { key: "saves", type: "morale", value: -2, source: "shaken" },
    ]);
    expect(frightened?.mods).toEqual([
      { key: "attack", type: "morale", value: -2, source: "frightened" },
      { key: "saves", type: "morale", value: -2, source: "frightened" },
    ]);
    // Panicked: saves only — the print does not penalize its attack rolls.
    expect(panicked?.mods).toEqual([
      { key: "saves", type: "morale", value: -2, source: "panicked" },
    ]);
    expect(panicked?.denies).toContain("attack-melee");
    expect(shaken?.denies).toBeUndefined();
    // All three are mind-affecting fear.
    for (const name of ["Shaken", "Frightened", "Panicked"]) {
      expect(pf1eConditionDef(name)?.mindAffecting, name).toBe(true);
      expect(pf1eConditionDef(name)?.fear, name).toBe(true);
    }
  });

  test("fear does not stack with fear, but stacks with untyped conditions", () => {
    const effects = readTacticalEffects({
      shaken: { flags: { pf1e: payloadOf("Shaken") } },
      frightened: { flags: { pf1e: payloadOf("Frightened") } },
      sickened: { flags: { pf1e: payloadOf("Sickened") } },
    }).effects;
    const resolved = resolveEffects(effects);
    // Same morale type to the same key keeps the worst (−2), never −4; the
    // untyped sickened penalty stacks (−2 attack morale + −2 attack untyped).
    expect(resolved.mods.attack).toBe(-4);
    expect(resolved.mods.saves).toBe(-4);
    expect(resolved.mods.damage).toBe(-2);
    // …and the two fear conditions alone would give −2/−2, not −4/−4.
    const fearOnly = resolveEffects(
      readTacticalEffects({
        shaken: { flags: { pf1e: payloadOf("Shaken") } },
        frightened: { flags: { pf1e: payloadOf("Frightened") } },
      }).effects,
    );
    expect(fearOnly.mods.attack).toBe(-2);
    expect(fearOnly.mods.saves).toBe(-2);
  });

  test("Stunned loses Dex and AC; Dazed takes no actions but has no AC penalty", () => {
    const stunned = payloadOf("Stunned");
    const dazed = payloadOf("Dazed");
    expect(stunned?.mods).toEqual([
      { key: "ac", type: "untyped", value: -2, source: "stunned" },
    ]);
    expect(stunned?.flags).toEqual({ deniedDexToAc: true, cannotAoO: true });
    expect(dazed?.mods).toBeUndefined();
    expect(dazed?.flags).toBeUndefined();
    // Both deny the same action kinds.
    expect(dazed?.denies).toEqual(stunned?.denies);
  });

  test("Grappled vs Pinned: the grappled penalty set is distinct from the pinned defense loss", () => {
    const grappled = payloadOf("Grappled");
    const pinned = payloadOf("Pinned");
    expect(grappled?.mods).toEqual([
      { key: "attack", type: "untyped", value: -2, source: "grappled" },
      { key: "cmb", type: "untyped", value: -2, source: "grappled" },
      { key: "ability.dex", type: "untyped", value: -4, source: "grappled" },
    ]);
    expect(grappled?.flags).toEqual({ cannotAoO: true });
    expect(grappled?.denies).toEqual(["move", "five-foot-step"]);
    // Pinned denies Dex and takes −4 AC; it carries no attack/CMB mods (its
    // escape-focused action set is narrower, and the print says they don't stack).
    expect(pinned?.mods).toEqual([
      { key: "ac", type: "untyped", value: -4, source: "pinned" },
    ]);
    expect(pinned?.flags).toEqual({ deniedDexToAc: true, cannotAoO: true });
    expect(pinned?.denies).toEqual([
      "move",
      "five-foot-step",
      "standard",
      "full-round",
      "swift",
    ]);
  });

  test("Prone penalizes melee attacks only; the AC split is a named note, not an invented mod", () => {
    const prone = payloadOf("Prone");
    expect(prone?.mods).toEqual([
      { key: "attackMelee", type: "untyped", value: -4, source: "prone" },
    ]);
    expect(prone?.denies).toEqual(["ranged-attack", "five-foot-step"]);
    const def = defOf("Prone");
    expect(def.notes.join(" ")).toMatch(/ranged/);
    expect(def.notes.join(" ")).toMatch(/melee/);
  });

  test("Blinded loses Dex to AC and takes −2 AC; Entangled is −2 attack and −4 Dex", () => {
    const blinded = payloadOf("Blinded");
    expect(blinded?.mods).toEqual([
      { key: "ac", type: "untyped", value: -2, source: "blinded" },
    ]);
    expect(blinded?.flags).toEqual({ deniedDexToAc: true });
    const entangled = payloadOf("Entangled");
    expect(entangled?.mods).toEqual([
      { key: "attack", type: "untyped", value: -2, source: "entangled" },
      { key: "ability.dex", type: "untyped", value: -4, source: "entangled" },
    ]);
    expect(entangled?.denies).toEqual(["run", "charge"]);
  });

  test("the helpless family all deny Dex to AC; Confused carries no numbers", () => {
    for (const name of [
      "Helpless",
      "Unconscious",
      "Paralyzed",
      "Petrified",
      "Dying",
      "Stable",
    ]) {
      const payload = payloadOf(name);
      expect(payload?.flags?.deniedDexToAc, name).toBe(true);
    }
    const confused = payloadOf("Confused");
    expect(confused?.mods).toBeUndefined();
    expect(confused?.denies).toBeUndefined();
    expect(pf1eConditionDef("Confused")?.mindAffecting).toBe(true);
  });

  test("Flat-Footed sets the derivation's own flags, not an AC number", () => {
    const ff = payloadOf("Flat-Footed");
    expect(ff?.mods).toBeUndefined();
    expect(ff?.flags).toEqual({ flatFooted: true, cannotAoO: true });
  });
});

describe("pf1eConditions — the derivation consumes them like any effect", () => {
  test("fatigued drops effective Str/Dex by 2, the melee attack and AC follow", () => {
    const base = deriveFromDocuments({ actor: actor() });
    const fatigued = readTacticalEffects({
      f: { flags: { pf1e: payloadOf("Fatigued") } },
    }).effects;
    const tired = deriveFromDocuments({ actor: actor(), effects: fatigued });
    expect(tired.abilities.str).toBe(14);
    expect(tired.abilities.dex).toBe(12);
    // Str mod 3→2, Dex mod 2→1: attack line and AC each drop exactly 1.
    expect(tired.attacks[0]?.attackBonuses[0]).toBe(
      (base.attacks[0]?.attackBonuses[0] ?? 0) - 1,
    );
    expect(tired.ac.normal).toBe(base.ac.normal - 1);
  });

  test("shaken drops all three saves by exactly 2 (the `saves` key applies to every save)", () => {
    const base = deriveFromDocuments({ actor: actor() });
    const shaken = readTacticalEffects({
      s: { flags: { pf1e: payloadOf("Shaken") } },
    }).effects;
    const scared = deriveFromDocuments({ actor: actor(), effects: shaken });
    expect(scared.saves.fort).toBe(base.saves.fort - 2);
    expect(scared.saves.ref).toBe(base.saves.ref - 2);
    expect(scared.saves.will).toBe(base.saves.will - 2);
  });

  test("blinded's denied Dex drops touch and flat-footed AC through the derivation", () => {
    const base = deriveFromDocuments({ actor: actor() });
    const blinded = readTacticalEffects({
      b: { flags: { pf1e: payloadOf("Blinded") } },
    }).effects;
    const dark = deriveFromDocuments({ actor: actor(), effects: blinded });
    // Base: 12/12/10 (Dex +2). Blinded removes the Dex bonus everywhere and
    // applies its own −2: touch 12→8, flat-footed 10→8, normal 12→8.
    expect(dark.ac.touch).toBe(base.ac.touch - 4);
    expect(dark.ac.flatFooted).toBe(base.ac.flatFooted - 2);
    expect(dark.ac.normal).toBe(base.ac.normal - 4);
  });

  test("exhaustion outranks fatigue in the derivation: −6 vs −2 to the attack line", () => {
    const fatigued = deriveFromDocuments({
      actor: actor(),
      effects: readTacticalEffects({
        f: { flags: { pf1e: payloadOf("Fatigued") } },
      }).effects,
    });
    const exhausted = deriveFromDocuments({
      actor: actor(),
      effects: readTacticalEffects({
        e: { flags: { pf1e: payloadOf("Exhausted") } },
      }).effects,
    });
    // Str 16: fatigued → 14 (mod 3→2, −1 attack); exhausted → 10 (mod 3→0, −3).
    expect(
      (exhausted.attacks[0]?.attackBonuses[0] ?? 0) -
        (fatigued.attacks[0]?.attackBonuses[0] ?? 0),
    ).toBe(-2);
  });
});

describe("pf1eConditions — the immunity hook (mind-affecting / named)", () => {
  test("mind-affecting immunity refuses the fear family and Confused, never Fatigued", () => {
    const immune = resolveEffects(
      readTacticalEffects({
        ward: {
          flags: { pf1e: { immune: { mindAffecting: true } } },
        },
      }).effects,
    );
    for (const name of [
      "Shaken",
      "Frightened",
      "Panicked",
      "Cowering",
      "Confused",
    ]) {
      const def = pf1eConditionDef(name);
      expect(def).not.toBeNull();
      expect(conditionRefusalFor(defOf(name), immune), name).toMatch(
        /mind-affecting/,
      );
    }
    for (const name of [
      "Fatigued",
      "Prone",
      "Blinded",
      "Entangled",
      "Stunned",
    ]) {
      const def = pf1eConditionDef(name);
      expect(def).not.toBeNull();
      expect(conditionRefusalFor(defOf(name), immune), name).toBeNull();
    }
  });

  test("named condition immunities refuse by name and stay name-specific", () => {
    const immune = resolveEffects(
      readTacticalEffects({
        ward: { flags: { pf1e: { immune: { conditions: ["Shaken"] } } } },
      }).effects,
    );
    expect(conditionRefusalFor(defOf("Shaken"), immune)).toMatch(
      /condition immunities/,
    );
    expect(conditionRefusalFor(defOf("Frightened"), immune)).toBeNull();
  });

  test("no protection at all refuses nothing", () => {
    const bare = resolveEffects([]);
    for (const def of PF1E_CONDITIONS)
      expect(conditionRefusalFor(def, bare)).toBeNull();
  });
});
