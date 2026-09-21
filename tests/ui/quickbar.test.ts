/**
 * §2.2 item 2 (G-10b/D-261) — the per-character quickbar's data half.
 *
 * The bar is only as good as its bindings: a slot is a *name for an action the sheet already
 * computes*, so the tests below cover the two ways that can go wrong at a real table — garbage in
 * the document (a bad edit must read as an empty slot, never crash the bar) and a binding that has
 * gone stale (the item was traded away, the wand ran dry) — plus the one write rule the flat-diff
 * store imposes: a flag write is the actor's whole `flags` subtree, so no other flag may be lost.
 */
import { describe, expect, test } from "vitest";
import type { ActorDocument } from "../../src/core/documents";
import { deriveFromActorDocument } from "../../src/packages/pf1e/actor";
import {
  bindQuickbarSlot,
  candidateToEntry,
  clearQuickbarSlot,
  quickbarCandidates,
  quickbarSlotNote,
  quickbarWriteOp,
  readQuickbar,
} from "../../src/ui/quickbar/model";

function wand(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    _id: "i-wand",
    name: "Wand of Misery",
    type: "item",
    system: {
      uses: { value: 3, max: 5, per: "charges" },
      cl: 5,
      consumable: {
        kind: "wand",
        casterLevel: 5,
        spell: { name: "Misery", level: 1, damageFormula: "" },
      },
      ...over,
    },
  };
}

function hero(over: {
  quickbar?: unknown;
  flags?: Record<string, unknown>;
  items?: Record<string, unknown>[];
} = {}): ActorDocument {
  return {
    _id: "a-hero",
    type: "actor",
    name: "Rex the Bold",
    ownership: { default: 0 },
    flags: {
      core: { sheet: true },
      ...(over.quickbar === undefined ? {} : { pf1e: { quickbar: over.quickbar } }),
      ...(over.flags ?? {}),
    },
    system: {
      pf1e: {
        abilities: { str: 16 },
        attacks: [
          {
            name: "Greataxe",
            damageDice: "1d12",
            damageBonus: 2,
            damageType: "slashing",
            twoHanded: true,
          },
        ],
        hp: 20,
        hpMax: 20,
      },
    },
    items: (over.items ?? [wand()]) as never,
    effects: [],
  } as unknown as ActorDocument;
}

const derivedOf = (actor: ActorDocument) => deriveFromActorDocument(actor, {});

describe("readQuickbar", () => {
  test("reads a bound slot and defaults the optionals", () => {
    const actor = hero({
      quickbar: [{ slot: 2, kind: "attack", label: "Greataxe", attackIndex: 0, itemId: null }],
    });
    expect(readQuickbar(actor)).toEqual([
      { slot: 2, kind: "attack", label: "Greataxe", attackIndex: 0, itemId: null },
    ]);
  });

  test("an unbound actor, a missing array or a non-array reads as empty", () => {
    expect(readQuickbar(hero())).toEqual([]);
    expect(readQuickbar(hero({ quickbar: { slot: 1 } }))).toEqual([]);
    expect(readQuickbar(hero({ quickbar: "nope" }))).toEqual([]);
  });

  test("malformed entries are dropped, never repaired into something else", () => {
    const actor = hero({
      quickbar: [
        { slot: 0, kind: "attack", label: "below the bar" },
        { slot: 9, kind: "attack", label: "above the bar" },
        { slot: 1, kind: "cast", label: "unknown verb" },
        { slot: 1, kind: "attack", label: "   " },
        { slot: 3, kind: "item", label: "no item id", itemId: null },
        { slot: 4, kind: "damage", label: "Second Greataxe", attackIndex: 0 },
      ],
    });
    expect(readQuickbar(actor).map((e) => e.slot)).toEqual([4]);
  });

  test("a slot bound twice keeps the first binding and the list stays in slot order", () => {
    const actor = hero({
      quickbar: [
        { slot: 3, kind: "attack", label: "third" },
        { slot: 1, kind: "attack", label: "first" },
        { slot: 3, kind: "damage", label: "third again" },
      ],
    });
    expect(readQuickbar(actor).map((e) => `${String(e.slot)}:${e.label}`)).toEqual([
      "1:first",
      "3:third",
    ]);
  });
});

describe("quickbarWriteOp", () => {
  test("writes every slot and keeps the actor's other flags and pf1e keys", () => {
    const actor = hero({ quickbar: [] });
    (actor.flags.pf1e as Record<string, unknown>).notes = "keep me";
    const op = quickbarWriteOp(actor, [
      { slot: 1, kind: "attack", label: "Greataxe", attackIndex: 0, itemId: null },
    ]);
    expect(op.kind).toBe("update");
    if (op.kind !== "update") return;
    expect(op.ref).toEqual({ coll: "actors", id: "a-hero" });
    // A flat diff cannot create intermediates: the write carries the whole flags subtree.
    expect(op.diff.flags).toEqual({
      core: { sheet: true },
      pf1e: {
        notes: "keep me",
        quickbar: [{ slot: 1, kind: "attack", label: "Greataxe", attackIndex: 0, itemId: null }],
      },
    });
  });

  test("an actor with no flags at all still writes a valid subtree", () => {
    const bare = { ...hero(), flags: {} } as ActorDocument;
    const op = quickbarWriteOp(bare, []);
    if (op.kind !== "update") return;
    expect(op.diff.flags).toEqual({ pf1e: { quickbar: [] } });
  });

  test("bind replaces one slot; clear empties it", () => {
    const start = [
      { slot: 1, kind: "attack" as const, label: "a", attackIndex: 0, itemId: null },
      { slot: 2, kind: "attack" as const, label: "b", attackIndex: 0, itemId: null },
    ];
    const bound = bindQuickbarSlot(start, {
      slot: 1,
      kind: "damage",
      label: "a damage",
      attackIndex: 0,
      itemId: null,
    });
    expect(bound.map((e) => `${String(e.slot)}:${e.label}`)).toEqual(["1:a damage", "2:b"]);
    expect(clearQuickbarSlot(bound, 1).map((e) => e.slot)).toEqual([2]);
  });
});

describe("quickbarCandidates", () => {
  test("lists each derived attack's attack and damage, plus the castable items", () => {
    const actor = hero();
    const candidates = quickbarCandidates(actor, derivedOf(actor));
    expect(candidates.map((c) => c.id)).toEqual(["attack:0", "damage:0", "item:i-wand"]);
    expect(candidates[0]).toMatchObject({ kind: "attack", label: "Greataxe", attackIndex: 0 });
    expect(candidates[1]?.label).toBe("Greataxe damage");
    expect(candidates[1]?.detail).toContain("1d12");
    expect(candidates[2]).toMatchObject({
      kind: "item",
      label: "Misery (Wand of Misery)",
      itemId: "i-wand",
    });
    expect(candidates[2]?.detail).toContain("charge");
  });

  test("a drained wand is not offered, and an unarmed character still offers its strike", () => {
    const drained = hero({ items: [wand({ uses: { value: 0, max: 5, per: "charges" } })] });
    expect(quickbarCandidates(drained, derivedOf(drained)).some((c) => c.kind === "item")).toBe(
      false,
    );
    const unarmed = {
      ...hero({ items: [] }),
      system: { pf1e: { abilities: { str: 10 }, hp: 8, hpMax: 8 } },
    } as ActorDocument;
    const candidates = quickbarCandidates(unarmed, derivedOf(unarmed));
    expect(candidates.map((c) => c.label)).toContain("Unarmed strike");
  });

  test("a candidate becomes the slot binding the runner reads", () => {
    const actor = hero();
    const candidate = quickbarCandidates(actor, derivedOf(actor))[2];
    if (candidate === undefined) throw new Error("no item candidate");
    expect(candidateToEntry(5, candidate)).toEqual({
      slot: 5,
      kind: "item",
      label: "Misery (Wand of Misery)",
      attackIndex: 0,
      itemId: "i-wand",
    });
  });
});

describe("quickbarSlotNote", () => {
  const actor = hero();
  const derived = derivedOf(actor);

  test("a healthy binding has nothing to say", () => {
    expect(
      quickbarSlotNote(
        actor,
        { slot: 1, kind: "attack", label: "Greataxe", attackIndex: 0, itemId: null },
        derived,
      ),
    ).toBe(null);
    expect(
      quickbarSlotNote(
        actor,
        { slot: 2, kind: "item", label: "wand", attackIndex: 0, itemId: "i-wand" },
        derived,
      ),
    ).toBe(null);
  });

  test("a stale binding is named, so the bar can say what is wrong", () => {
    expect(
      quickbarSlotNote(
        actor,
        { slot: 1, kind: "attack", label: "claw", attackIndex: 7, itemId: null },
        derived,
      ),
    ).toBe("the bound attack line is gone");
    expect(
      quickbarSlotNote(
        actor,
        { slot: 2, kind: "item", label: "wand", attackIndex: 0, itemId: "i-gone" },
        derived,
      ),
    ).toBe("the bound item is gone");
    const drained = hero({ items: [wand({ uses: { value: 0, max: 5, per: "charges" } })] });
    expect(
      quickbarSlotNote(
        drained,
        { slot: 2, kind: "item", label: "wand", attackIndex: 0, itemId: "i-wand" },
        derivedOf(drained),
      ),
    ).toBe("the bound item has no charges left");
  });
});
