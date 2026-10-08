/**
 * Narrow PF1e shop purchase adapter for Campaign Codex.
 *
 * This pure planner only accepts the ArenaStar PF1e `system.value` / `system.pf1e.currency`
 * shape, uses copper as the integer calculation unit, and returns an atomic host Op batch.
 * It never mutates documents or interprets arbitrary system fields.
 */
import type {
  ActorDocument,
  CodexShopStockRow,
  ItemDocument,
  JournalDocument,
  Json,
} from "./documents";
import { sameCodexRef } from "./campaignCodex";
import type { Op } from "./ops";

const MAX_PURCHASE_QUANTITY = 1_000;
const MAX_COPPER = Number.MAX_SAFE_INTEGER;
const COIN_KEYS = ["pp", "gp", "sp", "cp"] as const;
type CoinKey = (typeof COIN_KEYS)[number];
type Currency = Record<CoinKey, number>;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function gpToCopper(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1e12)
    return null;
  const copper = Math.round(value * 100);
  return Math.abs(value * 100 - copper) <= 1e-7 && Number.isSafeInteger(copper)
    ? copper
    : null;
}

function parsePriceText(value: string): number | null {
  const trimmed = value.trim();
  if (!/^(?:\d{1,10}(?:\.\d{1,2})?|\.\d{1,2})$/.test(trimmed)) return null;
  const amount = Number(trimmed);
  return gpToCopper(amount);
}

function currencyOf(actor: ActorDocument): Currency | null {
  const pf1e = record(actor.system.pf1e) ? actor.system.pf1e : null;
  const raw = pf1e && record(pf1e.currency) ? pf1e.currency : null;
  if (!raw) return null;
  const currency = {} as Currency;
  for (const key of COIN_KEYS) {
    const value = raw[key];
    if (value === undefined) {
      currency[key] = 0;
      continue;
    }
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
      return null;
    currency[key] = value;
  }
  return currency;
}

function totalCopper(currency: Currency): number | null {
  const total = currency.pp * 1_000 + currency.gp * 100 + currency.sp * 10 + currency.cp;
  return Number.isSafeInteger(total) && total <= MAX_COPPER ? total : null;
}

function currencyChange(copper: number): Currency {
  let rest = copper;
  const pp = Math.floor(rest / 1_000);
  rest %= 1_000;
  const gp = Math.floor(rest / 100);
  rest %= 100;
  const sp = Math.floor(rest / 10);
  const cp = rest % 10;
  return { pp, gp, sp, cp };
}

function quantityOf(item: ItemDocument): number | null {
  const system = record(item.system) ? item.system : {};
  const foundry = record(system.foundry) ? system.foundry : {};
  const raw = system.quantity ?? foundry.quantity;
  if (raw === undefined) return 1;
  return typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0 && raw <= 1_000_000_000
    ? raw
    : null;
}

function sourcePrice(row: CodexShopStockRow, item: ItemDocument): number | null {
  if (row.unitPrice !== undefined) return parsePriceText(row.unitPrice);
  const system = record(item.system) ? item.system : {};
  return gpToCopper(system.value);
}

export interface CodexPurchasePlanInput {
  sheet: JournalDocument;
  row: CodexShopStockRow;
  sourceItem: ItemDocument;
  actor: ActorDocument;
  quantity: number;
  itemId: string;
}

export type CodexPurchaseQuote =
  | { ok: true; unitCopper: number; totalCopper: number; walletCopper: number }
  | { ok: false; error: string };

export type CodexPurchasePlan =
  | { ok: true; ops: Op[]; unitCopper: number; totalCopper: number; itemName: string }
  | { ok: false; error: string };

export type CodexLootClaimPlan =
  | { ok: true; ops: Op[]; itemName: string }
  | { ok: false; error: string };

/** Transfer an item from a loot Entry into an owned actor without touching currency. */
export function planCodexLootClaim(input: CodexPurchasePlanInput): CodexLootClaimPlan {
  const { sheet, row, sourceItem, actor, quantity, itemId } = input;
  const shop = sheet.codex?.shop;
  if (sheet.type !== "journal" || sourceItem.type !== "item")
    return { ok: false, error: "A readable item and Codex Entry are required." };
  if (!shop || shop.mode !== "loot") return { ok: false, error: "This Entry is not an active loot container." };
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > MAX_PURCHASE_QUANTITY)
    return { ok: false, error: `Choose a whole-number quantity from 1 to ${MAX_PURCHASE_QUANTITY}.` };
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(itemId))
    return { ok: false, error: "A valid item identity is required." };
  const currentRow = shop.stock.find((candidate) => candidate.id === row.id);
  if (!currentRow || !sameCodexRef(currentRow.item, row.item))
    return { ok: false, error: "This stock row changed. Refresh the loot container and try again." };
  if (currentRow.quantity !== null && currentRow.quantity < quantity)
    return { ok: false, error: "There is not enough stock for that quantity." };

  const nextStock = shop.stock.map((candidate) =>
    candidate.id === currentRow.id && candidate.quantity !== null
      ? { ...candidate, quantity: candidate.quantity - quantity }
      : candidate,
  );
  const flags = record(sourceItem.flags.pf1e) ? sourceItem.flags.pf1e : {};
  const matchingItem = actor.items.find((candidate) =>
    record(candidate.flags.pf1e) && candidate.flags.pf1e.codexImportedFrom === sourceItem._id,
  );
  const ops: Op[] = [{
    kind: "update",
    ref: { coll: "journals", id: sheet._id },
    diff: { "codex.shop.stock": nextStock as unknown as Json },
  }];

  if (matchingItem) {
    const oldQuantity = quantityOf(matchingItem);
    if (oldQuantity === null || oldQuantity + quantity > 1_000_000_000)
      return { ok: false, error: "The matching inventory stack has an unsupported quantity." };
    ops.push({
      kind: "update",
      ref: { coll: "items", id: matchingItem._id, parent: { coll: "actors", id: actor._id } },
      diff: { "system.quantity": oldQuantity + quantity },
    });
  } else {
    const system = record(sourceItem.system) ? sourceItem.system : {};
    const copy: ItemDocument = {
      ...sourceItem,
      _id: itemId,
      name: sourceItem.name,
      ownership: { default: 0 },
      flags: {
        ...sourceItem.flags,
        pf1e: { ...flags, codexImportedFrom: sourceItem._id },
      },
      system: { ...system, quantity },
      effects: sourceItem.effects.map((effect) => ({ ...effect })),
    };
    ops.push({ kind: "create", coll: "items", parent: { coll: "actors", id: actor._id }, data: copy });
  }
  return { ok: true, ops, itemName: sourceItem.name };
}

/**
 * Validate a purchase's current price and wallet shape without deciding whether the wallet is
 * funded. The UI uses this to keep unsupported schemas read-only; the host planner below performs
 * the final funds/stock checks immediately before commit.
 */
export function quoteCodexPurchase(
  input: Omit<CodexPurchasePlanInput, "itemId">,
): CodexPurchaseQuote {
  const { sheet, row, sourceItem, actor, quantity } = input;
  const shop = sheet.codex?.shop;
  if (sheet.type !== "journal" || sourceItem.type !== "item")
    return { ok: false, error: "A readable item and Codex Entry are required." };
  if (!shop || shop.mode !== "shop")
    return { ok: false, error: "This Entry is not an active shop." };
  if (shop.currencyLabel && shop.currencyLabel.trim().toLocaleLowerCase() !== "gp")
    return { ok: false, error: "The shop currency label is not supported by the PF1e adapter." };
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > MAX_PURCHASE_QUANTITY)
    return { ok: false, error: `Choose a whole-number quantity from 1 to ${MAX_PURCHASE_QUANTITY}.` };
  const currentRow = shop.stock.find((candidate) => candidate.id === row.id);
  if (!currentRow || !sameCodexRef(currentRow.item, row.item))
    return { ok: false, error: "This stock row changed. Refresh the shop and try again." };
  if (currentRow.quantity !== null && currentRow.quantity < quantity)
    return { ok: false, error: "There is not enough stock for that quantity." };

  const rawUnitCopper = sourcePrice(currentRow, sourceItem);
  if (rawUnitCopper === null)
    return { ok: false, error: "This item has no supported non-negative PF1e price." };
  const markup = shop.markup ?? 1;
  if (!Number.isFinite(markup) || markup < 0 || markup > 1_000)
    return { ok: false, error: "The shop markup is invalid." };
  const unitCopper = Math.round(rawUnitCopper * markup);
  const total = unitCopper * quantity;
  if (!Number.isSafeInteger(unitCopper) || !Number.isSafeInteger(total) || total > MAX_COPPER)
    return { ok: false, error: "The calculated price is outside the supported range." };

  const currency = currencyOf(actor);
  if (!currency) return { ok: false, error: "This actor has no supported PF1e currency block." };
  const wallet = totalCopper(currency);
  if (wallet === null)
    return { ok: false, error: "This actor's PF1e wallet is outside the supported range." };
  return { ok: true, unitCopper, totalCopper: total, walletCopper: wallet };
}

/** Validate current wallet/stock and produce one atomic shop + actor update batch. */
export function planCodexPurchase(input: CodexPurchasePlanInput): CodexPurchasePlan {
  const { sheet, row, sourceItem, actor, quantity, itemId } = input;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(itemId))
    return { ok: false, error: "A valid item identity is required." };
  const quote = quoteCodexPurchase({ sheet, row, sourceItem, actor, quantity });
  if (!quote.ok) return quote;
  if (quote.walletCopper < quote.totalCopper)
    return { ok: false, error: "There are not enough funds for this purchase." };
  const shop = sheet.codex?.shop;
  if (!shop) return { ok: false, error: "This Entry is not an active shop." };
  const currentRow = shop.stock.find((candidate) => candidate.id === row.id);
  if (!currentRow) return { ok: false, error: "This stock row changed. Refresh the shop and try again." };

  const nextStock = shop.stock.map((candidate) =>
    candidate.id === currentRow.id && candidate.quantity !== null
      ? { ...candidate, quantity: candidate.quantity - quantity }
      : candidate,
  );
  const nextCurrency = currencyChange(quote.walletCopper - quote.totalCopper);
  const flags = record(sourceItem.flags.pf1e) ? sourceItem.flags.pf1e : {};
  const matchingItem = actor.items.find((candidate) =>
    record(candidate.flags.pf1e) && candidate.flags.pf1e.codexImportedFrom === sourceItem._id,
  );
  const ops: Op[] = [
    {
      kind: "update",
      ref: { coll: "journals", id: sheet._id },
      diff: { "codex.shop.stock": nextStock as unknown as Json },
    },
    {
      kind: "update",
      ref: { coll: "actors", id: actor._id },
      diff: { "system.pf1e.currency": nextCurrency as unknown as Json },
    },
  ];

  if (matchingItem) {
    const oldQuantity = quantityOf(matchingItem);
    if (oldQuantity === null || oldQuantity + quantity > 1_000_000_000)
      return { ok: false, error: "The matching inventory stack has an unsupported quantity." };
    ops.push({
      kind: "update",
      ref: { coll: "items", id: matchingItem._id, parent: { coll: "actors", id: actor._id } },
      diff: { "system.quantity": oldQuantity + quantity },
    });
  } else {
    const system = record(sourceItem.system) ? sourceItem.system : {};
    const copy: ItemDocument = {
      ...sourceItem,
      _id: itemId,
      name: sourceItem.name,
      ownership: { default: 0 },
      flags: {
        ...sourceItem.flags,
        pf1e: { ...flags, codexImportedFrom: sourceItem._id },
      },
      system: { ...system, quantity },
      effects: sourceItem.effects.map((effect) => ({ ...effect })),
    };
    ops.push({
      kind: "create",
      coll: "items",
      parent: { coll: "actors", id: actor._id },
      data: copy,
    });
  }
  return {
    ok: true,
    ops,
    unitCopper: quote.unitCopper,
    totalCopper: quote.totalCopper,
    itemName: sourceItem.name,
  };
}
