import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import type { ActorDocument, Json } from "../../src/core/documents";
import { deriveFromDocuments } from "../../src/packages/pf1e/actor";
import {
  authoredNumber,
  isPF1eActor,
  pf1eSheetEdit,
  pf1eSheetView,
} from "../../src/ui/sheets/pf1eSheetModel";

const owner = { id: "player", role: "PLAYER" as const };
function actor(pf1e: Record<string, Json> = {}): ActorDocument {
  return {
    _id: "fighter",
    type: "actor",
    name: "Fighter",
    ownership: { default: 2, player: 3 },
    flags: {},
    system: { pf1e, unrelated: 42 },
    items: [],
    effects: [],
  };
}

describe("PF1e sheet presentation and authorized edit intents", () => {
  test("only explicitly PF1e actors select the specialized sheet", () => {
    expect(isPF1eActor(actor())).toBe(true);
    for (const pf1e of [undefined, null, "pf1e", []]) {
      expect(
        isPF1eActor({ ...actor(), system: pf1e === undefined ? {} : { pf1e } }),
      ).toBe(false);
    }
    expect(isPF1eActor({ ...actor(), type: "item" })).toBe(false);
  });
  test("AC 18/13/15 is the contract readout, with no mutation or stored derived totals", () => {
    const a = actor({ abilities: { dex: 16 }, armorClass: { armor: 5 } });
    const before = structuredClone(a);
    const view = pf1eSheetView(a);
    expect(view.derived).toEqual(deriveFromDocuments({ actor: a }));
    expect(view.derived.ac).toEqual({ normal: 18, touch: 13, flatFooted: 15 });
    expect(a).toEqual(before);
    expect(authoredNumber(a, "abilities.str")).toBeNull();
  });
  test("reads all shipped bestiary actors through the same normalization/derivation", () => {
    const pack = JSON.parse(
      readFileSync(
        new URL("../../systems/pf1e-core/packs/bestiary.json", import.meta.url),
        "utf8",
      ),
    );
    for (const entry of pack.entries) {
      const a = { ...actor(), ...entry.data } as ActorDocument;
      const view = pf1eSheetView(a);
      expect(view.derived).toEqual(deriveFromDocuments({ actor: a }));
      expect(view.derived.ac.normal).toBeGreaterThan(10);
      expect(view.derived.converted.length).toBeGreaterThan(0);
    }
    expect(pack.entries).toHaveLength(6);
  });
  test("effects change effective scores, never the authored editor value, and disabling reverts", () => {
    const a = actor({ abilities: { str: 16 } });
    a.effects = [
      {
        _id: "buff",
        type: "effect",
        name: "Custom strength",
        ownership: { default: 0 },
        system: {},
        changes: [],
        disabled: false,
        flags: {
          pf1e: {
            mods: [{ key: "ability.str", type: "enhancement", value: 2 }],
          },
        },
      },
    ];
    expect(pf1eSheetView(a).derived.abilities.str).toBe(18);
    expect(authoredNumber(a, "abilities.str")).toBe(16);
    const effect = a.effects[0];
    if (!effect) throw new Error("missing fixture effect");
    effect.disabled = true;
    expect(pf1eSheetView(a).derived.abilities.str).toBe(16);
  });
  test("owner edit returns only a dotted authored Op and never mutates its document", () => {
    const a = actor({ abilities: { str: 16, dex: 14 } });
    const before = structuredClone(a);
    expect(pf1eSheetEdit(a, owner, "abilities.str", "18")).toEqual({
      error: null,
      ops: [
        {
          kind: "update",
          ref: { coll: "actors", id: "fighter" },
          diff: { "system.pf1e.abilities.str": 18 },
        },
      ],
    });
    expect(a).toEqual(before);
  });
  test("imported save edit preserves sibling totals and prevents ability double counting", () => {
    const a = actor({ fort: 5, ref: 3, will: 1, conMod: 3, dexMod: 2 });
    expect(authoredNumber(a, "saves.fort")).toBe(5);
    const result = pf1eSheetEdit(a, owner, "saves.fort", "6");
    expect(result.ops).toEqual([
      {
        kind: "update",
        ref: { coll: "actors", id: "fighter" },
        diff: {
          "system.pf1e.saves": { fort: 6, ref: 3, will: 1 },
          "system.pf1e.savesAsTotal": true,
        },
      },
    ]);
    const edited = actor({
      ...(a.system.pf1e as Record<string, Json>),
      saves: { fort: 6, ref: 3, will: 1 },
      savesAsTotal: true,
    });
    expect(pf1eSheetView(edited).derived.saves).toEqual({
      fort: 6,
      ref: 3,
      will: 1,
    });
  });
  test("denies unauthenticated/read-only edits and arbitrary paths, including derived AC", () => {
    const a = actor();
    for (const user of [null, { id: "other", role: "PLAYER" as const }])
      expect(pf1eSheetEdit(a, user, "hp", "8").ops).toEqual([]);
    for (const field of [
      "ownership.player",
      "__proto__.x",
      "ac.normal",
      "system.hp",
      "name",
    ])
      expect(pf1eSheetEdit(a, owner, field, "18").ops).toEqual([]);
  });
  test("rejects blank, nonfinite, fractional and negative capacity data; negative current HP remains valid", () => {
    for (const raw of ["", " ", "NaN", "Infinity", "1e999", "2.5"])
      expect(pf1eSheetEdit(actor(), owner, "hp", raw).error).not.toBeNull();
    expect(pf1eSheetEdit(actor(), owner, "hpMax", "-1").ops).toEqual([]);
    expect(pf1eSheetEdit(actor(), owner, "hp", "-1").error).toBeNull();
  });
});

describe("ability damage/drain authoring (CRB p.555, S02 slice)", () => {
  test("first damage edit materializes only the missing group; the op is a dotted authored path", () => {
    const a = actor({ abilities: { str: 18 } });
    const before = structuredClone(a);
    const result = pf1eSheetEdit(a, owner, "abilitiesDamage.str", "3");
    expect(result.error).toBeNull();
    expect(result.ops).toEqual([
      {
        kind: "update",
        ref: { coll: "actors", id: "fighter" },
        diff: { "system.pf1e.abilitiesDamage": { str: 3 } },
      },
    ]);
    expect(a).toEqual(before);
  });

  test("existing damage edits use one dotted op and preserve sibling accumulators", () => {
    const a = actor({ abilitiesDamage: { str: 3, dex: 1 } });
    expect(pf1eSheetEdit(a, owner, "abilitiesDamage.dex", "5").ops).toEqual([
      {
        kind: "update",
        ref: { coll: "actors", id: "fighter" },
        diff: { "system.pf1e.abilitiesDamage.dex": 5 },
      },
    ]);
    expect(authoredNumber(a, "abilitiesDamage.str")).toBe(3);
  });

  test("damage and drain drive the effective readout without touching authored scores", () => {
    const a = actor({
      abilities: { str: 18, dex: 16 },
      abilitiesDamage: { str: 3 },
      abilitiesDrain: { dex: 4 },
      saves: { fort: 5, ref: 2, will: 2 },
      baseAttack: 6,
    });
    const d = pf1eSheetView(a).derived;
    expect(authoredNumber(a, "abilities.str")).toBe(18);
    expect(d.abilities.str).toBe(18); // damage never reduces the score
    expect(d.abilities.dex).toBe(12); // drain does
    expect(d.abilityMods.str).toBe(3); // +4 − 1
    expect(d.abilityMods.dex).toBe(1); // +1 (drained 16→12)
    expect(d.attacks[0]?.attackBonus).toBe(6 + 3); // melee uses eff Str
    expect(d.explain.abilities).toContain("drain DEX −4");
    expect(d.explain.abilities).toContain("damage STR 3 → penalties STR −1");
  });

  test("negative, fractional and malformed damage edits are refused; structured imports are read-only", () => {
    expect(
      pf1eSheetEdit(actor(), owner, "abilitiesDamage.str", "-1").ops,
    ).toEqual([]);
    expect(
      pf1eSheetEdit(actor(), owner, "abilitiesDrain.con", "1.5").ops,
    ).toEqual([]);
    expect(pf1eSheetEdit(actor(), owner, "hitDice", "-1").ops).toEqual([]); // hitDice uses the same list
    expect(pf1eSheetEdit(actor(), owner, "hitDice", "6").error).toBeNull();
    // A non-object accumulator is data this editor will not silently replace.
    const structured = actor({ abilitiesDamage: "3 (str)" });
    const refused = pf1eSheetEdit(
      structured,
      owner,
      "abilitiesDamage.str",
      "2",
    );
    expect(refused.ops).toEqual([]);
    expect(refused.error).toContain("read-only");
    // And unknown abilities never become editable paths.
    expect(
      pf1eSheetEdit(actor(), owner, "abilitiesDamage.luck", "2").ops,
    ).toEqual([]);
  });

  test("the derived fields the Svelte tab renders exist and stay zero for undamaged actors", () => {
    const d = pf1eSheetView(actor({ abilities: { str: 18 } })).derived;
    expect(d.abilityDamageTaken).toEqual({
      str: 0,
      dex: 0,
      con: 0,
      int: 0,
      wis: 0,
      cha: 0,
    });
    expect(d.abilityDrainTaken).toEqual(d.abilityDamageTaken);
    expect(d.abilityDamagePenalty).toEqual(d.abilityDamageTaken);
    expect(d.explain.abilities).toContain("no ability damage or drain");
  });
});
