import { describe, expect, test } from "vitest";
import type {
  ActorDocument,
  CodexShopConfig,
  ItemDocument,
  JournalDocument,
  UserDocument,
} from "../../src/core/documents";
import {
  codexItemDescription,
  codexItemUpdateOp,
  createActorInventoryItemOp,
  createCodexShopItemOps,
  deleteActorInventoryItemOp,
  parseCodexItemDraft,
} from "../../src/ui/journals/codexInventoryEditor";

function user(id: string, role: UserDocument["role"] = "PLAYER"): UserDocument {
  return {
    _id: id,
    type: "user",
    name: id,
    ownership: { default: 0 },
    flags: {},
    system: {},
    role,
    character: null,
    color: "#fff",
  };
}

function shopConfig(
  mode: CodexShopConfig["mode"] = "shop",
  audience: CodexShopConfig["audience"] = { kind: "inherit" },
): CodexShopConfig {
  return { mode, audience, stock: [] };
}

function entry(
  ownership: JournalDocument["ownership"] = { default: 3 },
  shop = shopConfig(),
): JournalDocument {
  return {
    _id: "entry-sheet",
    type: "journal",
    name: "The Copper Kettle",
    ownership,
    flags: {},
    system: {},
    pages: [],
    codex: { version: 1, kind: "entry", links: [], widgets: [], shop },
  };
}

function draftFields(
  overrides: Partial<{
    name: string;
    description: string;
    weightLb: string;
    priceGp: string;
    quantity: string;
  }> = {},
) {
  return {
    name: "  Moonstone  ",
    description: "A pale gem that glows beneath moonlight.",
    weightLb: "0.2",
    priceGp: "12.50",
    quantity: "4",
    ...overrides,
  };
}

function draft() {
  const result = parseCodexItemDraft(draftFields());
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

describe("Campaign Codex GM shop and inventory editor helpers", () => {
  test("parses required PF1e item fields and bounds quantity/price for the shop adapter", () => {
    expect(parseCodexItemDraft(draftFields())).toEqual({
      ok: true,
      value: {
        name: "Moonstone",
        description: "A pale gem that glows beneath moonlight.",
        weightLb: 0.2,
        priceGp: 12.5,
        quantity: 4,
      },
    });
    expect(
      parseCodexItemDraft(draftFields({ priceGp: "12.345" })),
    ).toMatchObject({
      ok: false,
      error: expect.stringContaining("two decimal places"),
    });
    expect(parseCodexItemDraft(draftFields({ quantity: "1.5" }))).toMatchObject(
      {
        ok: false,
        error: expect.stringContaining("whole number"),
      },
    );
    expect(parseCodexItemDraft(draftFields({ name: "   " }))).toMatchObject({
      ok: false,
    });
    expect(parseCodexItemDraft(draftFields({ description: "  " }))).toMatchObject({
      ok: false,
      error: expect.stringContaining("Description must be between 1"),
    });
  });

  test("creates a world Item and its stock row atomically with audience-scoped read access", () => {
    const sheet = entry(
      { default: 0, "player-one": 1, "player-two": 1 },
      shopConfig("shop", { kind: "selectedUsers", userIds: ["player-one"] }),
    );
    const planned = createCodexShopItemOps({
      sheet,
      shop: sheet.codex?.shop ?? shopConfig(),
      draft: draft(),
      itemId: "moonstone-item",
      stockRowId: "moonstone-row",
      users: [user("player-one"), user("player-two"), user("gm", "GM")],
    });

    expect(planned.ok).toBe(true);
    if (!planned.ok) throw new Error(planned.error);
    expect(planned.ops).toHaveLength(2);
    expect(planned.ops[0]).toMatchObject({ kind: "create", coll: "items" });
    expect(planned.item).toMatchObject({
      _id: "moonstone-item",
      type: "item",
      name: "Moonstone",
      ownership: { default: 0, "player-one": 1 },
      system: {
        category: "equipment",
        quantity: 4,
        value: 12.5,
        weight: 0.2,
        description: { value: "A pale gem that glows beneath moonlight." },
      },
    });
    expect(planned.stock).toMatchObject({
      id: "moonstone-row",
      item: { coll: "items", id: "moonstone-item" },
      quantity: 4,
      unitPrice: "12.5",
      order: 0,
    });
    expect(planned.ops[1]).toMatchObject({
      kind: "update",
      ref: { coll: "journals", id: sheet._id },
      diff: {
        codex: {
          shop: {
            mode: "shop",
            stock: [planned.stock],
          },
        },
      },
    });
  });

  test("lets a public inherited shop item remain readable by new journal readers", () => {
    const sheet = entry({ default: 3 }, shopConfig("shop", { kind: "inherit" }));
    const planned = createCodexShopItemOps({
      sheet,
      shop: sheet.codex?.shop ?? shopConfig(),
      draft: draft(),
      itemId: "public-inherited-item",
      stockRowId: "public-inherited-row",
      users: [],
    });

    expect(planned.ok).toBe(true);
    if (!planned.ok) throw new Error(planned.error);
    expect(planned.item.ownership).toEqual({ default: 1 });
  });

  test("keeps created shop items private for GM-only stock and omits loot prices from rows", () => {
    const sheet = entry({ default: 3 }, shopConfig("loot", { kind: "gmOnly" }));
    const planned = createCodexShopItemOps({
      sheet,
      shop: sheet.codex?.shop ?? shopConfig(),
      draft: draft(),
      itemId: "hidden-loot-item",
      stockRowId: "hidden-loot-row",
      users: [user("player-one"), user("gm", "GM")],
    });

    expect(planned.ok).toBe(true);
    if (!planned.ok) throw new Error(planned.error);
    expect(planned.item.ownership).toEqual({ default: 0 });
    expect(planned.stock).not.toHaveProperty("unitPrice");
    expect(planned.item.system.value).toBe(12.5);
    expect(planned.stock.quantity).toBe(4);
  });

  test("rejects invalid or duplicate shop stock identities and excess stock rows", () => {
    const sheet = entry();
    const shop = sheet.codex?.shop ?? shopConfig();
    const base = {
      sheet,
      shop,
      draft: draft(),
      itemId: "new-item",
      stockRowId: "new-row",
      users: [] as UserDocument[],
    };
    expect(
      createCodexShopItemOps({ ...base, existingItemIds: ["new-item"] }),
    ).toMatchObject({ ok: false });
    expect(createCodexShopItemOps({ ...base, itemId: "bad/id" })).toMatchObject(
      { ok: false },
    );
    expect(
      createCodexShopItemOps({
        ...base,
        shop: {
          ...shop,
          stock: Array.from({ length: 200 }, (_, index) => ({
            id: `row-${index}`,
            item: { coll: "items", id: `item-${index}` },
            quantity: null,
            order: index,
          })),
        },
      }),
    ).toMatchObject({
      ok: false,
      error: expect.stringContaining("at most 200"),
    });
  });

  test("updates existing item fields without discarding PF1e description metadata", () => {
    const item: ItemDocument = {
      _id: "ring-item",
      type: "item",
      name: "Old ring",
      ownership: { default: 3 },
      flags: {},
      system: {
        quantity: 1,
        value: 5,
        weight: 0,
        description: {
          value: "An old description.",
          chat: "preserve this field",
        },
      },
      effects: [],
    };
    const result = codexItemUpdateOp({ coll: "items", id: item._id }, item, {
      name: "New ring",
      description: "A better description.",
      weightLb: 0.1,
      priceGp: 18.25,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    if (result.op.kind !== "update") throw new Error("Expected an item update operation");
    expect(result.op).toMatchObject({
      kind: "update",
      ref: { coll: "items", id: item._id },
      diff: {
        name: "New ring",
        "system.description": {
          value: "A better description.",
          chat: "preserve this field",
        },
        "system.weight": 0.1,
        "system.value": 18.25,
      },
    });
    expect(result.op.diff).not.toHaveProperty("ownership");
    expect(codexItemDescription(item)).toBe("An old description.");
  });

  test("creates and deletes an item on a selected character without touching other actor data", () => {
    const actor: ActorDocument = {
      _id: "character-one",
      type: "actor",
      name: "Mira",
      ownership: { default: 0, "player-one": 3 },
      flags: {},
      system: { pf1e: { currency: { gp: 8 } } },
      items: [],
      effects: [],
    };
    const created = createActorInventoryItemOp(actor, "mira-potion", draft());

    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error(created.error);
    expect(created.op).toMatchObject({
      kind: "create",
      coll: "items",
      parent: { coll: "actors", id: actor._id },
      data: {
        _id: "mira-potion",
        name: "Moonstone",
        ownership: { default: 0 },
        system: { quantity: 4, value: 12.5, weight: 0.2 },
      },
    });
    expect(deleteActorInventoryItemOp(actor._id, "mira-potion")).toEqual({
      kind: "delete",
      ref: {
        coll: "items",
        id: "mira-potion",
        parent: { coll: "actors", id: actor._id },
      },
    });
  });
});
