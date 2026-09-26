/**
 * D-312 — the join between an **attack line** and the **item** it was authored from.
 *
 * A binding fires on the `attack` event only for the line that *names* its item, so this one
 * field (`system.pf1e.attacks[i].itemId`) is the whole connection: the writer
 * (`createAttackFromWeaponOp`, the sheet's "make an attack from this item" verb) and the reader
 * (`attackLineItemId`, what the sheet's resolve and the quickbar call before firing a cue) have
 * to agree, and a rename on either side would silently stop every swing cue from firing. Nothing
 * here re-implements the rules — the weapon block is the converted pack's own Longsword row.
 */
import { describe, expect, test } from "vitest";
import type { ActorDocument, ItemDocument } from "../../src/core/documents";
import type { Json } from "../../src/core/documents";
import { attackLineItemId, createAttackFromWeaponOp, pf1eItemView } from "../../src/ui/sheets/pf1eItemsTab";

/** `weapons-ammo.json` → `longsword`, verbatim (the shape `pf1e_inventory.spec.ts` uses). */
const LONGSWORD_SYSTEM = {
  category: "weapon",
  weapon: {
    class: "melee",
    handedness: "one-handed",
    proficiency: "martial",
    damageDice: "1d8",
    damageType: "slashing",
    critThreatMin: 19,
    critMultiplier: 2,
  },
  value: 15,
  weight: 4,
  hardness: 10,
};

function sword(id = "i-longsword"): ItemDocument {
  return { _id: id, type: "item", name: "Longsword", ownership: { default: 0 }, flags: {},
    system: LONGSWORD_SYSTEM as unknown as Json, effects: [] } as unknown as ItemDocument;
}

function fighter(items: ItemDocument[], pf1e: Record<string, Json> = {}): ActorDocument {
  return { _id: "a-fighter", type: "actor", name: "Fighter", ownership: { default: 0 },
    flags: {}, system: { pf1e }, items, effects: [] };
}

describe("the attack line's item link (D-312)", () => {
  test("the verb writes the item id the cue later reads", () => {
    const actor = fighter([sword()]);
    const item = pf1eItemView(actor, "i-longsword")?.item;
    expect(item).toBeDefined();
    if (item === undefined) return;

    const built = createAttackFromWeaponOp(actor, item);
    expect("op" in built).toBe(true);
    if (!("op" in built)) return;
    expect(built.op).toMatchObject({ kind: "update", ref: { coll: "actors", id: "a-fighter" } });
    const entry = built.entry;
    expect(entry.itemId).toBe("i-longsword");

    // Read the line back the way the resolve path does: same index, same id.
    const applied = fighter([sword()], { attacks: [entry] });
    expect(attackLineItemId(applied, 0)).toBe("i-longsword");
    // A second line from the same weapon is refused (the sheet's own duplicate rule) and does
    // not disturb the first.
    expect(createAttackFromWeaponOp(applied, item)).toMatchObject({ error: expect.stringContaining("already has an attack line") });
  });

  test("a line that names no item is nobody's line, and a broken list reads as none", () => {
    const handAuthored = fighter([sword()], { attacks: [{ name: "Longsword", damageDice: "1d8" }] });
    expect(attackLineItemId(handAuthored, 0)).toBeNull();
    // Out of range, an empty id, and a malformed list are all "this line has no item" rather
    // than a crash or a guess: the cue fires on a named item or not at all.
    expect(attackLineItemId(handAuthored, 3)).toBeNull();
    expect(attackLineItemId(fighter([], { attacks: [{ itemId: "" }] }), 0)).toBeNull();
    expect(attackLineItemId(fighter([], { attacks: [] }), 0)).toBeNull();
    expect(attackLineItemId(fighter([], { attacks: "nope" as unknown as Json }), 0)).toBeNull();
    expect(attackLineItemId(fighter([], { attacks: [7 as unknown as Json] }), 0)).toBeNull();
    expect(attackLineItemId(fighter([]), 0)).toBeNull();
    // …and a weapon with no weapon block cannot produce a line at all, so it can never be the
    // source of a swing cue.
    const loot: ItemDocument = { ...sword("i-rock"), name: "Rock",
      system: { category: "loot" } as unknown as Json } as unknown as ItemDocument;
    const holder = fighter([loot]);
    const rock = pf1eItemView(holder, "i-rock")?.item;
    if (rock !== undefined)
      expect(createAttackFromWeaponOp(holder, rock)).toMatchObject({ error: expect.stringContaining("no weapon data") });
  });
});
