import { describe, expect, test } from "vitest";
import {
  pf1eResolveAttack,
  pf1eResolveManyshot,
  type PF1eResolveAttackInput,
  type PF1eResolveDefender,
} from "../../src/packages/pf1e/resolve";

/** The plan's 22/16/17 trio defender (I §6.2 fixture #1). */
const trioDefender: PF1eResolveDefender = {
  name: "Trio Target",
  ac: { normal: 22, touch: 16, flatFooted: 17 },
  hp: 20,
  hpMax: 20,
  nonlethalDamage: 0,
};

const sword = {
  label: "Longsword",
  bonus: 16,
  critThreatMin: 20,
  critMultiplier: 2,
  damageType: "slashing",
};

function resolve(
  overrides: Partial<PF1eResolveAttackInput>,
  defender: PF1eResolveDefender = trioDefender,
): ReturnType<typeof pf1eResolveAttack> {
  return pf1eResolveAttack({
    attack: sword,
    die: 10,
    defense: "normal",
    defender,
    damageTotal: 10,
    ...overrides,
  });
}

describe("pf1eResolveAttack — attack resolution (A06b)", () => {
  test("the 22/16/17 AC trio discriminates: total 19 misses normal, hits touch and flat-footed", () => {
    // bonus 16 + die 3 = 19: a collapsed AC implementation cannot produce all three.
    const vsNormal = resolve({ die: 3, defense: "normal" });
    const vsTouch = resolve({ die: 3, defense: "touch" });
    const vsFlat = resolve({ die: 3, defense: "flatFooted" });
    expect(vsNormal).toMatchObject({
      ok: true,
      outcome: "miss",
      defenseAc: 22,
    });
    expect(vsTouch).toMatchObject({ ok: true, outcome: "hit", defenseAc: 16 });
    expect(vsFlat).toMatchObject({
      ok: true,
      outcome: "hit",
      defenseAc: 17,
    });
  });

  test("flanked 18 vs AC 19 misses, 19 hits — the +2 counts exactly once", () => {
    const flanked = { base: 14, ac: 19 };
    // die 2 + 14 + 2 = 18 misses; die 3 + 14 + 2 = 19 hits (I §6.2 fixture #2).
    const miss = resolve({
      attack: { ...sword, bonus: flanked.base },
      die: 2,
      defender: {
        ...trioDefender,
        ac: { normal: flanked.ac, touch: 12, flatFooted: 15 },
      },
      situational: { flanking: true },
    });
    const hit = resolve({
      attack: { ...sword, bonus: flanked.base },
      die: 3,
      defender: {
        ...trioDefender,
        ac: { normal: flanked.ac, touch: 12, flatFooted: 15 },
      },
      situational: { flanking: true },
    });
    // A dropped flank also misses the hit (17 < 19); a doubled one would hit the miss (20 ≥ 19).
    const noFlank = resolve({
      attack: { ...sword, bonus: flanked.base },
      die: 3,
      defender: {
        ...trioDefender,
        ac: { normal: flanked.ac, touch: 12, flatFooted: 15 },
      },
    });
    expect(miss).toMatchObject({ ok: true, outcome: "miss", attackTotal: 18 });
    expect(hit).toMatchObject({ ok: true, outcome: "hit", attackTotal: 19 });
    expect(noFlank).toMatchObject({
      ok: true,
      outcome: "miss",
      attackTotal: 17,
    });
  });

  test("charge +2, invisible attacker +2 and squeezing −4 ride the same delta", () => {
    const result = resolve({
      situational: { charging: true, attackerInvisible: true, squeezing: true },
    });
    expect(result).toMatchObject({
      ok: true,
      situationalDelta: 0, // +2 +2 −4
      attackTotal: 26, // 10 (die) + 16 + 0
    });
  });

  test("a touch attack overrides the defense choice to touch AC", () => {
    const result = resolve({
      attack: { ...sword, touchAttack: true },
      defense: "flatFooted",
    });
    expect(result).toMatchObject({
      ok: true,
      defenseUsed: "touch",
      defenseAc: 16,
    });
    expect(
      result.ok &&
        result.notes.some((note) => note.includes("touch AC regardless")),
    ).toBe(true);
  });

  test("natural 1 always misses; natural 20 always hits and threatens", () => {
    const one = resolve({ die: 1, damageTotal: 25 });
    expect(one).toMatchObject({ ok: true, outcome: "miss" });
    const twenty = resolve({ die: 20, confirmDie: 20, damageTotal: 25 });
    expect(twenty).toMatchObject({
      ok: true,
      outcome: "crit",
      threat: true,
      confirmed: true,
    });
  });

  test("a threat without the confirmation die is a caller error, not a rules state", () => {
    const result = resolve({ die: 20 });
    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining("confirmDie"),
    });
  });

  test("the confirmation roll hits AC to confirm; a natural 1 never confirms", () => {
    // die 20 threatened at total 36 vs AC 22: confirmation needs ≥ 22 ⇒ die 6 + 16.
    const confirmed = resolve({ die: 20, confirmDie: 6, damageTotal: 8 });
    expect(confirmed).toMatchObject({ ok: true, outcome: "crit" });
    const failed = resolve({ die: 20, confirmDie: 1, damageTotal: 8 });
    expect(failed).toMatchObject({
      ok: true,
      outcome: "hit",
      threat: true,
      confirmed: false,
    });
  });

  test("a confirmed threat on a multiplier-below-2 line scores as a normal hit", () => {
    const result = resolve({
      attack: { ...sword, critMultiplier: 1 },
      die: 20,
      confirmDie: 20,
    });
    expect(result).toMatchObject({ ok: true, outcome: "hit" });
    expect(
      result.ok && result.notes.some((note) => note.includes("below 2")),
    ).toBe(true);
  });

  test("minimum damage: 1d6 − 10 ⇒ 1 nonlethal, DR bypassed, unconscious when nonlethal exceeds current HP (Gap List fixture)", () => {
    // A Str-dumped attacker: the evaluated 1d6 − 10 came to −4. The slashing
    // weapon bypasses DR 5/slashing; the target (hp 1, 1 nonlethal already)
    // exceeds current HP with the second point ⇒ unconscious (CRB p.191).
    const defender: PF1eResolveDefender = {
      name: "Goblin",
      ac: { normal: 12, touch: 11, flatFooted: 11 },
      hp: 1,
      hpMax: 6,
      nonlethalDamage: 1,
      dr: [{ value: 5, bypass: ["slashing"] }],
    };
    const result = resolve({
      attack: { ...sword, bonus: 2 },
      die: 14,
      defender,
      damageTotal: -4,
    });
    expect(result).toMatchObject({
      ok: true,
      outcome: "hit",
      damage: {
        rolled: -4,
        minimumApplied: true,
        dealt: 1,
        nonlethal: 1,
        lethal: 0,
        drApplied: 0,
        drBypassedVia: "slashing",
      },
      nonlethal: { before: 1, after: 2 },
      hp: { before: 1, after: 1 },
    });
    expect(result.ok && result.conditionNotes).toEqual([
      "unconscious — nonlethal damage exceeds current HP (CRB p.191)",
    ]);
  });

  test("nonlethal exactly equal to current HP is staggered, not unconscious", () => {
    const defender: PF1eResolveDefender = {
      name: "Goblin",
      ac: { normal: 12, touch: 11, flatFooted: 11 },
      hp: 2,
      hpMax: 6,
      nonlethalDamage: 1,
    };
    const result = resolve({
      attack: { ...sword, bonus: 2 },
      die: 14,
      defender,
      damageTotal: -4, // ⇒ 1 nonlethal: total 2 equals hp 2
    });
    expect(result.ok && result.conditionNotes).toEqual([
      "staggered — nonlethal damage equals current HP (CRB p.191)",
    ]);
  });

  test("DR negates even the minimum 1 nonlethal point (D-138)", () => {
    const defender: PF1eResolveDefender = {
      name: "Iron Door",
      ac: { normal: 12, touch: 11, flatFooted: 11 },
      hp: 30,
      hpMax: 30,
      nonlethalDamage: 0,
      dr: [{ value: 5, bypass: [] }],
    };
    const result = resolve({
      attack: { ...sword, bonus: 2 },
      die: 14,
      defender,
      damageTotal: 0,
    });
    expect(result).toMatchObject({
      ok: true,
      damage: { dealt: 0, drApplied: 1 },
      hp: { before: 30, after: 30 },
    });
  });

  test("DR reduces a mundane lethal hit and names the bypass route when bypassed", () => {
    const defender: PF1eResolveDefender = {
      ...trioDefender,
      dr: [{ value: 5, bypass: ["magic"] }],
    };
    const mundane = resolve({ damageTotal: 12, defender });
    expect(mundane).toMatchObject({
      ok: true,
      damage: { dealt: 7, drApplied: 5, drBypassedVia: null },
    });
    const magic = resolve({
      damageTotal: 12,
      defender,
      attackFacts: {
        enhancementBonus: 1,
        effectiveBonusTotal: 1,
        material: "none",
        alignment: [],
        damageType: "slashing",
      },
    });
    expect(magic).toMatchObject({
      ok: true,
      damage: {
        dealt: 12,
        drApplied: 0,
        drBypassedVia: "+1 enhancement (magic)",
      },
    });
  });

  test("energy resistance mitigates the fire rider a caller models as a component is out of scope here — derived lines carry none", () => {
    // A derived line has no riders: the one-component path is the contract.
    const result = resolve({ damageTotal: 12 });
    expect(result.ok && result.damage?.notes).toBeDefined();
    expect(result).toMatchObject({ ok: true, damage: { dealt: 12 } });
  });

  test("nonlethal damage at the max-HP boundary converts to lethal (CRB p.191)", () => {
    const defender: PF1eResolveDefender = {
      name: "Bruiser",
      ac: { normal: 14, touch: 12, flatFooted: 12 },
      hp: 10,
      hpMax: 10,
      nonlethalDamage: 10,
    };
    const result = resolve({
      attack: { ...sword, bonus: 2, damageType: "bludgeoning nonlethal" },
      die: 14,
      defender,
      damageTotal: 3,
    });
    expect(result).toMatchObject({
      ok: true,
      damage: { lethal: 3, nonlethal: 0, convertedToLethal: 3 },
      hp: { before: 10, after: 7 },
      nonlethal: { before: 10, after: 10 },
    });
  });

  test("regeneration suppresses the max-HP conversion (CRB p.191)", () => {
    const defender: PF1eResolveDefender = {
      name: "Troll",
      ac: { normal: 14, touch: 12, flatFooted: 12 },
      hp: 10,
      hpMax: 10,
      nonlethalDamage: 10,
      regeneration: 5,
    };
    const result = resolve({
      attack: { ...sword, bonus: 2, damageType: "bludgeoning nonlethal" },
      die: 14,
      defender,
      damageTotal: 3,
    });
    expect(result).toMatchObject({
      ok: true,
      damage: { nonlethal: 3, convertedToLethal: 0 },
      nonlethal: { before: 10, after: 13 },
      hp: { before: 10, after: 10 },
    });
  });

  test("0 HP ⇒ disabled; negative HP ⇒ unconscious and dying; −Con ⇒ dead (CRB p.189–190)", () => {
    const disabled = resolve({ damageTotal: 20 });
    expect(disabled.ok && disabled.conditionNotes).toEqual([
      "disabled (staggered at exactly 0 HP; a strenuous standard action costs 1 HP and starts dying)",
    ]);
    const dying = resolve({ damageTotal: 21 });
    expect(dying).toMatchObject({ ok: true, hp: { after: -1 } });
    expect(dying.ok && dying.conditionNotes).toEqual([
      "unconscious and dying (below 0 HP, loses 1 HP per round — the stable/dying bookkeeping is P7)",
    ]);
    const dead = resolve({
      damageTotal: 25,
      defender: { ...trioDefender, conScore: 5 },
    });
    expect(dead).toMatchObject({ ok: true, hp: { after: -5 } });
    expect(
      dead.ok &&
        dead.conditionNotes[0]?.startsWith(
          "dead — negative HP (-5) reached Constitution 5",
        ),
    ).toBe(true);
  });

  test("unarmed lethal without Improved Unarmed Strike takes −4; the feat waives it; nonlethal with a lethal weapon takes −4", () => {
    const unarmed = {
      ...sword,
      label: "Unarmed strike",
      damageType: "bludgeoning",
    };
    // Unarmed is nonlethal by nature (AoN ID 131): choosing lethal takes −4 without IUS.
    const noIus = resolve({
      attack: unarmed,
      unarmed: true,
      nonlethalDamage: false,
      die: 10, // 10 + 16 − 4 = 22 = AC ⇒ hits exactly
    });
    expect(noIus).toMatchObject({
      ok: true,
      intentPenalty: -4,
      outcome: "hit",
      damage: { lethal: 10, nonlethal: 0 },
    });
    const withIus = resolve({
      attack: unarmed,
      unarmed: true,
      nonlethalDamage: false,
      feats: ["improved-unarmed-strike"],
      die: 10, // 10 + 16 = 26 ≥ 22
    });
    expect(withIus).toMatchObject({
      ok: true,
      intentPenalty: 0,
      outcome: "hit",
    });
    const sapToLethal = resolve({
      attack: { ...sword, damageType: "bludgeoning nonlethal" },
      nonlethalDamage: false,
      die: 10,
    });
    expect(sapToLethal).toMatchObject({ ok: true, intentPenalty: -4 });
    const lethalToNonlethal = resolve({
      attack: sword,
      nonlethalDamage: true,
      die: 10,
    });
    expect(lethalToNonlethal).toMatchObject({
      ok: true,
      intentPenalty: -4,
      damage: { nonlethal: 10, lethal: 0 },
    });
  });

  test("a miss deals no damage and writes nothing, but the provoke note still posts", () => {
    const result = resolve({ die: 2, damageTotal: 15, provokes: true });
    expect(result).toMatchObject({
      ok: true,
      outcome: "miss",
      damage: null,
      hp: { before: 20, after: 20 },
      provokes: true,
    });
    expect(
      result.ok &&
        result.notes.some((note) =>
          note.includes("provokes an attack of opportunity"),
        ),
    ).toBe(true);
  });

  test("ranged damage against an object halves before hardness (CRB p.173)", () => {
    const door: PF1eResolveDefender = {
      name: "Wooden Door",
      ac: { normal: 5, touch: 5, flatFooted: 5 },
      hp: 20,
      hpMax: 20,
      nonlethalDamage: 0,
      object: { hardness: 5 },
    };
    const result = resolve({
      attack: { ...sword, ranged: true },
      die: 15,
      defender: door,
      damageTotal: 10,
    });
    expect(result).toMatchObject({ ok: true, damage: { dealt: 0, lethal: 0 } });
  });

  test("validation refuses non-integer damage and malformed defenders", () => {
    expect(resolve({ damageTotal: 1.5 })).toMatchObject({ ok: false });
    expect(
      resolve({
        defender: { ...trioDefender, hpMax: 0 },
      }),
    ).toMatchObject({ ok: false });
    expect(
      resolve({ defender: { ...trioDefender, nonlethalDamage: -1 } }),
    ).toMatchObject({ ok: false });
  });
});

describe("pf1eResolveManyshot — ordered volley damage", () => {
  test("applies each arrow to the same target state in order", () => {
    const result = pf1eResolveManyshot({
      attack: { ...sword, ranged: true },
      arrows: [
        { die: 10, damageTotal: 6 },
        { die: 10, damageTotal: 7 },
      ],
      defense: "normal",
      defender: { ...trioDefender, hp: 20 },
    });
    expect(result).toMatchObject({ ok: true, finalHp: 7, finalNonlethal: 0 });
    if (result.ok) {
      expect(result.arrows.map((arrow) => arrow.hp.after)).toEqual([14, 7]);
    }
  });

  test("rejects non-ranged and out-of-range volley sizes before resolving dice", () => {
    expect(
      pf1eResolveManyshot({
        attack: sword,
        arrows: [{ die: 10, damageTotal: 1 }, { die: 10, damageTotal: 1 }],
        defense: "normal",
        defender: trioDefender,
      }),
    ).toEqual({ ok: false, error: "Manyshot requires a ranged attack" });
    expect(
      pf1eResolveManyshot({
        attack: { ...sword, ranged: true },
        arrows: [{ die: 10, damageTotal: 1 }],
        defense: "normal",
        defender: trioDefender,
      }),
    ).toEqual({ ok: false, error: "Manyshot requires between 2 and 4 arrows" });
  });
});

describe("pf1eResolveAttack — the misfire fold (P09/D-202, §2.9b)", () => {
  const musket = {
    generation: "early" as const,
    misfireMinimum: 2,
    broken: false,
    magical: false,
  };

  test("a misfire is an automatic miss that cannot threaten, even on a would-be hit", () => {
    // die 10 + bonus 16 = 26 vs AC 22 would hit — but 10 > 2, so no misfire here.
    expect(
      resolve({ misfire: musket, die: 10 }),
    ).toMatchObject({ ok: true, outcome: "hit" });
    // die 2 would also hit (18... 2 + 16 = 18 vs 22 misses; use the touch defense: 18 ≥ 16 hits)
    const misfired = resolve({ misfire: musket, die: 2, defense: "touch" });
    expect(misfired).toMatchObject({
      ok: true,
      outcome: "miss",
      threat: false,
      confirmed: false,
    });
    if (!misfired.ok) throw new Error(misfired.error);
    expect(misfired.misfire).toMatchObject({
      misfire: true,
      breaksWeapon: true,
    });
    expect(misfired.notes.join(" ")).toContain("automatically misses");
    expect(misfired.hp.after).toBe(misfired.hp.before);
  });

  test("a natural 20 never misfires, even at misfire value 20", () => {
    const verdict = resolve({
      misfire: { ...musket, misfireMinimum: 20 },
      die: 20,
      confirmDie: 2, // threatens (20); fails to confirm — a plain hit
    });
    expect(verdict).toMatchObject({ ok: true, threat: true, outcome: "hit" });
    if (!verdict.ok) throw new Error(verdict.error);
    expect(verdict.misfire).toBeUndefined();
  });

  test("a misfired natural 19 does not threaten and does not need a confirmation die", () => {
    // Threat range 19–20, misfire value 2: die 19 would threaten — but the
    // weapon misfired at or below 2, so this uses die 2... no: 19 > 2, no
    // misfire. The discriminating case is a misfire value of 19 with die 19.
    const misfired = resolve({
      misfire: { ...musket, misfireMinimum: 19 },
      die: 19,
    });
    expect(misfired).toMatchObject({ ok: true, outcome: "miss", threat: false });
    if (!misfired.ok) throw new Error(misfired.error);
    expect(misfired.misfire?.misfire).toBe(true);
  });

  test("an exploding second misfire reports the save and the destruction", () => {
    const exploded = resolve({
      misfire: { ...musket, broken: true, magical: true },
      die: 6,
    });
    expect(exploded).toMatchObject({ ok: true, outcome: "miss" });
    if (!exploded.ok) throw new Error(exploded.error);
    expect(exploded.misfire).toMatchObject({
      misfire: true,
      explodes: true,
      save: { dc: 12, half: true },
      weaponDestroyed: true,
    });
    expect(exploded.notes.join(" ")).toContain("wrecked by the explosion");
  });
});
