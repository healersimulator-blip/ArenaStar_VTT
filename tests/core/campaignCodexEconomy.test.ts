import { describe, expect, test } from "vitest";
import type {
  ActorDocument,
  ItemDocument,
  JournalDocument,
} from "../../src/core/documents";
import {
  planCodexLootClaim,
  planCodexPurchase,
  quoteCodexPurchase,
} from "../../src/core/campaignCodexEconomy";

function sourceItem(): ItemDocument {
  return {
    _id: "loot-source-item",
    type: "item",
    name: "Healing herb",
    ownership: { default: 3 },
    flags: { pf1e: { source: "field-kit" } },
    system: { quantity: 1, value: 5 },
    effects: [],
  };
}

function lootSheet(quantity: number | null): JournalDocument {
  return {
    _id: "loot-entry",
    type: "journal",
    name: "Abandoned cache",
    ownership: { default: 3 },
    flags: {},
    system: {},
    pages: [],
    codex: {
      version: 1,
      kind: "entry",
      links: [],
      widgets: [],
      quests: [],
      shop: {
        mode: "loot",
        audience: { kind: "inherit" },
        stock: [
          {
            id: "herb-row",
            item: { coll: "items", id: "loot-source-item" },
            quantity,
            order: 0,
          },
        ],
      },
    },
  };
}

function shopSheet(quantity: number | null, markup = 1, unitPrice = "2"): JournalDocument {
  const base = lootSheet(quantity);
  const codex = base.codex;
  const shop = codex?.shop;
  if (!codex || !shop) throw new Error("Expected a configured shop");
  return {
    ...base,
    codex: {
      ...codex,
      shop: {
        ...shop,
        mode: "shop",
        markup,
        currencyLabel: "gp",
        stock: shop.stock.map((row) => ({ ...row, unitPrice })),
      },
    },
  };
}

function stockRow(sheet: JournalDocument) {
  const row = sheet.codex?.shop?.stock[0];
  if (!row) throw new Error("Expected one Codex stock row");
  return row;
}

function recipient(items: ItemDocument[] = []): ActorDocument {
  return {
    _id: "loot-recipient",
    type: "actor",
    name: "Ranger",
    ownership: { default: 0, "player-1": 3 },
    flags: {},
    system: { pf1e: { currency: { gp: 7 } } },
    items,
    effects: [],
  };
}

describe("Campaign Codex loot-claim planner", () => {
  test("decrements stock and creates an item copy without charging currency", () => {
    const sheet = lootSheet(4);
    const item = sourceItem();
    const actor = recipient();
    const plan = planCodexLootClaim({
      sheet,
      row: stockRow(sheet),
      sourceItem: item,
      actor,
      quantity: 2,
      itemId: "claimed-herb-stack",
    });

    expect(plan).toMatchObject({ ok: true, itemName: "Healing herb" });
    if (!plan.ok) throw new Error(plan.error);
    expect(plan.ops).toHaveLength(2);
    expect(plan.ops[0]).toMatchObject({
      kind: "update",
      ref: { coll: "journals", id: sheet._id },
      diff: {
        "codex.shop.stock": [
          {
            id: "herb-row",
            item: { coll: "items", id: item._id },
            quantity: 2,
            order: 0,
          },
        ],
      },
    });
    const create = plan.ops[1];
    expect(create?.kind).toBe("create");
    if (create?.kind !== "create")
      throw new Error("Expected a nested item create");
    expect(create).toMatchObject({
      coll: "items",
      parent: { coll: "actors", id: actor._id },
    });
    expect(create.data).toMatchObject({
      _id: "claimed-herb-stack",
      name: "Healing herb",
      ownership: { default: 0 },
      flags: { pf1e: { source: "field-kit", codexImportedFrom: item._id } },
      system: { quantity: 2, value: 5 },
    });
    expect(
      plan.ops.some(
        (op) =>
          op.kind === "update" &&
          op.ref.coll === "actors" &&
          Object.keys(op.diff).some((path) => path.includes("currency")),
      ),
    ).toBe(false);
  });

  test("adds claimed quantity to the recipient's existing stack from the same source", () => {
    const sheet = lootSheet(null);
    const item = sourceItem();
    const existing: ItemDocument = {
      ...item,
      _id: "existing-herb-stack",
      flags: { pf1e: { codexImportedFrom: item._id } },
      system: { quantity: 3 },
    };
    const actor = recipient([existing]);
    const plan = planCodexLootClaim({
      sheet,
      row: stockRow(sheet),
      sourceItem: item,
      actor,
      quantity: 2,
      itemId: "unused-new-stack",
    });

    expect(plan).toMatchObject({ ok: true, itemName: "Healing herb" });
    if (!plan.ok) throw new Error(plan.error);
    expect(plan.ops).toHaveLength(2);
    expect(plan.ops[1]).toMatchObject({
      kind: "update",
      ref: {
        coll: "items",
        id: existing._id,
        parent: { coll: "actors", id: actor._id },
      },
      diff: { "system.quantity": 5 },
    });
  });

  test("rejects non-loot sheets, stale rows, and quantities exceeding current stock", () => {
    const sheet = lootSheet(1);
    const item = sourceItem();
    const actor = recipient();
    const row = stockRow(sheet);
    const codex = sheet.codex;
    const shop = codex?.shop;
    if (!codex || !shop) throw new Error("Expected a configured loot Entry");
    const shopModeSheet: JournalDocument = {
      ...sheet,
      codex: { ...codex, shop: { ...shop, mode: "shop" } },
    };

    expect(
      planCodexLootClaim({
        sheet: shopModeSheet,
        row,
        sourceItem: item,
        actor,
        quantity: 1,
        itemId: "item-one",
      }),
    ).toMatchObject({ ok: false });
    expect(
      planCodexLootClaim({
        sheet,
        row: { ...row, item: { coll: "items", id: "other-item" } },
        sourceItem: item,
        actor,
        quantity: 1,
        itemId: "item-two",
      }),
    ).toMatchObject({ ok: false });
    expect(
      planCodexLootClaim({
        sheet,
        row,
        sourceItem: item,
        actor,
        quantity: 2,
        itemId: "item-three",
      }),
    ).toMatchObject({
      ok: false,
      error: "There is not enough stock for that quantity.",
    });
  });
});

describe("Campaign Codex PF1e purchase quote and planner", () => {
  test("quotes markup in copper without hiding underfunding from the host transaction", () => {
    const sheet = shopSheet(3, 2, "2.00");
    const actor = recipient(); // 7 GP: a valid wallet, but less than the marked-up 8 GP total.
    const input = { sheet, row: stockRow(sheet), sourceItem: sourceItem(), actor, quantity: 2 };
    expect(quoteCodexPurchase(input)).toEqual({
      ok: true,
      unitCopper: 400,
      totalCopper: 800,
      walletCopper: 700,
    });
    expect(planCodexPurchase({ ...input, itemId: "purchase-copy" })).toMatchObject({
      ok: false,
      error: "There are not enough funds for this purchase.",
    });
    expect(stockRow(sheet).quantity).toBe(3);
    expect(actor.system.pf1e).toMatchObject({ currency: { gp: 7 } });
  });

  test("plans one atomic stock, wallet, and inventory transfer", () => {
    const sheet = shopSheet(3, 2, "2.00");
    const actor = {
      ...recipient(),
      system: { pf1e: { currency: { pp: 0, gp: 10, sp: 0, cp: 0 } } },
    };
    const plan = planCodexPurchase({
      sheet,
      row: stockRow(sheet),
      sourceItem: sourceItem(),
      actor,
      quantity: 2,
      itemId: "purchase-copy",
    });
    expect(plan).toMatchObject({ ok: true, unitCopper: 400, totalCopper: 800 });
    if (!plan.ok) throw new Error(plan.error);
    expect(plan.ops).toHaveLength(3);
    expect(plan.ops[0]).toMatchObject({
      kind: "update",
      ref: { coll: "journals", id: sheet._id },
      diff: { "codex.shop.stock": [{ ...stockRow(sheet), quantity: 1 }] },
    });
    expect(plan.ops[1]).toMatchObject({
      kind: "update",
      ref: { coll: "actors", id: actor._id },
      diff: { "system.pf1e.currency": { pp: 0, gp: 2, sp: 0, cp: 0 } },
    });
    expect(plan.ops[2]).toMatchObject({
      kind: "create",
      coll: "items",
      parent: { coll: "actors", id: actor._id },
      data: { _id: "purchase-copy", name: "Healing herb", system: { quantity: 2 } },
    });
    expect(stockRow(sheet).quantity).toBe(3);
    expect(actor.system.pf1e).toMatchObject({ currency: { gp: 10 } });
    expect(actor.items).toHaveLength(0);
  });

  test("fails closed for unsupported currencies, wallets, stale rows, malformed prices, and unsafe totals", () => {
    const sheet = shopSheet(3);
    const row = stockRow(sheet);
    const item = sourceItem();
    const actor = recipient();
    const input = { sheet, row, sourceItem: item, actor, quantity: 1 };
    const codex = sheet.codex;
    const shop = codex?.shop;
    if (!codex || !shop) throw new Error("Expected a configured shop");
    const unsupportedCurrencySheet: JournalDocument = {
      ...sheet,
      codex: { ...codex, shop: { ...shop, currencyLabel: "sp" } },
    };

    expect(quoteCodexPurchase({
      ...input,
      sheet: unsupportedCurrencySheet,
    })).toMatchObject({ ok: false, error: "The shop currency label is not supported by the PF1e adapter." });
    expect(quoteCodexPurchase({
      ...input,
      actor: { ...actor, system: {} },
    })).toMatchObject({ ok: false, error: "This actor has no supported PF1e currency block." });
    expect(quoteCodexPurchase({
      ...input,
      actor: { ...actor, system: { pf1e: { currency: { gp: -1 } } } },
    })).toMatchObject({ ok: false, error: "This actor has no supported PF1e currency block." });
    expect(quoteCodexPurchase({
      ...input,
      row: { ...row, item: { coll: "items", id: "replaced-item" } },
    })).toMatchObject({ ok: false, error: "This stock row changed. Refresh the shop and try again." });
    const malformedRow = { ...row, unitPrice: "1.234" };
    const malformedCodex = sheet.codex;
    const malformedShop = malformedCodex?.shop;
    if (!malformedCodex || !malformedShop) throw new Error("Expected a configured shop");
    const malformedPriceSheet: JournalDocument = {
      ...sheet,
      codex: { ...malformedCodex, shop: { ...malformedShop, stock: [malformedRow] } },
    };
    expect(quoteCodexPurchase({
      ...input,
      sheet: malformedPriceSheet,
      row: malformedRow,
    })).toMatchObject({ ok: false, error: "This item has no supported non-negative PF1e price." });

    const unsafe = shopSheet(null, 1_000, "9999999999.99");
    expect(quoteCodexPurchase({
      sheet: unsafe,
      row: stockRow(unsafe),
      sourceItem: item,
      actor,
      quantity: 1_000,
    })).toMatchObject({ ok: false, error: "The calculated price is outside the supported range." });
  });
});
