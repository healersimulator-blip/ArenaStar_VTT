/**
 * Pure document/Op helpers for the Campaign Codex GM inventory editors.
 * Shop stock is stored as a world Item plus a Codex stock-row reference; character inventory
 * remains embedded on the selected Actor. Both workflows use the normal host-authorized Op path.
 */
import type {
  ActorDocument,
  CodexShopConfig,
  CodexShopStockRow,
  ItemDocument,
  JournalDocument,
  Json,
  Ownership,
  UserDocument,
} from "../../core/documents";
import { OWNERSHIP_LEVELS } from "../../core/documents";
import type { DocRef } from "../../core/documents";
import type { Op } from "../../core/ops";
import { can } from "../../core/permissions";
import { codexAudienceAllows } from "../../core/campaignCodex";

const ITEM_ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_STOCK_ROWS = 200;
const MAX_ITEM_QUANTITY = 1_000_000_000;
const MAX_ITEM_WEIGHT_LB = 1_000_000_000;
const MAX_ITEM_PRICE_GP = 9_999_999_999.99;
const MAX_ITEM_DESCRIPTION_LENGTH = 16_000;

export interface CodexItemDraftFields {
  name: string;
  description: string;
  /** Number inputs may bind as numbers in Svelte; string drafts also preserve partial edits. */
  weightLb: string | number;
  priceGp: string | number;
  quantity: string | number;
}

export interface CodexItemDraft {
  name: string;
  description: string;
  weightLb: number;
  priceGp: number;
  quantity: number;
}

export type CodexItemDraftResult =
  { ok: true; value: CodexItemDraft } | { ok: false; error: string };

/** Validate the same minimum item fields used by both GM create forms. */
export function parseCodexItemDraft(
  fields: CodexItemDraftFields,
): CodexItemDraftResult {
  const name = fields.name.trim();
  if (name.length === 0 || name.length > 128)
    return {
      ok: false,
      error: "Item name must be between 1 and 128 characters.",
    };
  const description = fields.description.trim();
  if (description.length === 0 || description.length > MAX_ITEM_DESCRIPTION_LENGTH)
    return {
      ok: false,
      error: `Description must be between 1 and ${MAX_ITEM_DESCRIPTION_LENGTH} characters.`,
    };

  const weightText = String(fields.weightLb).trim();
  const weightLb = Number(weightText);
  if (
    weightText === "" ||
    !Number.isFinite(weightLb) ||
    weightLb < 0 ||
    weightLb > MAX_ITEM_WEIGHT_LB
  )
    return { ok: false, error: "Weight must be a non-negative number." };

  const priceText = String(fields.priceGp).trim();
  if (!/^(?:\d{1,10}(?:\.\d{1,2})?|\.\d{1,2})$/.test(priceText))
    return {
      ok: false,
      error:
        "Price must be a non-negative GP amount with at most two decimal places.",
    };
  const priceGp = Number(priceText);
  if (!Number.isFinite(priceGp) || priceGp < 0 || priceGp > MAX_ITEM_PRICE_GP)
    return { ok: false, error: "Price is outside the supported PF1e range." };

  const quantityText = String(fields.quantity).trim();
  const quantity = Number(quantityText);
  if (
    quantityText === "" ||
    !Number.isSafeInteger(quantity) ||
    quantity < 0 ||
    quantity > MAX_ITEM_QUANTITY
  )
    return {
      ok: false,
      error: `Quantity must be a whole number from 0 to ${MAX_ITEM_QUANTITY}.`,
    };

  return {
    ok: true,
    value: {
      name,
      description: fields.description.trim(),
      weightLb,
      priceGp,
      quantity,
    },
  };
}

function ownershipForShopAudience(
  sheet: JournalDocument,
  shop: CodexShopConfig,
  users: readonly UserDocument[],
): Ownership {
  // An inherited shop on a journal that is readable by default can safely keep new players in
  // sync as they join. Otherwise the Item stays private by default and receives read-only grants
  // only for current users who can read the parent sheet and pass the shop audience.
  const ownership: Ownership = { default: OWNERSHIP_LEVELS.NONE };
  const inheritsPublicSheetRead =
    (shop.audience === undefined || shop.audience.kind === "inherit") &&
    sheet.ownership.default >= OWNERSHIP_LEVELS.LIMITED;
  if (inheritsPublicSheetRead) {
    ownership.default = OWNERSHIP_LEVELS.LIMITED;
    return ownership;
  }
  for (const user of users) {
    if (user.role === "GM" || user.role === "ASSISTANT") continue;
    const viewer = { id: user._id, role: user.role };
    if (
      can(viewer, "read", sheet, "journals") &&
      codexAudienceAllows(shop.audience, viewer)
    )
      ownership[user._id] = OWNERSHIP_LEVELS.LIMITED;
  }
  return ownership;
}

function itemDocument(
  id: string,
  draft: CodexItemDraft,
  ownership: Ownership,
): ItemDocument {
  return {
    _id: id,
    type: "item",
    name: draft.name,
    ownership,
    flags: {},
    system: {
      category: "equipment",
      quantity: draft.quantity,
      value: draft.priceGp,
      weight: draft.weightLb,
      description: { value: draft.description },
    },
    effects: [],
  };
}

function priceText(value: number): string {
  return value.toFixed(2).replace(/\.?0+$/, "");
}

export type CodexShopItemCreateResult =
  | { ok: true; item: ItemDocument; stock: CodexShopStockRow; ops: Op[] }
  | { ok: false; error: string };

/** Create the Item and append its stock row in the same atomic host transaction. */
export function createCodexShopItemOps(input: {
  sheet: JournalDocument;
  shop: CodexShopConfig;
  draft: CodexItemDraft;
  itemId: string;
  stockRowId: string;
  users: readonly UserDocument[];
  existingItemIds?: readonly string[];
}): CodexShopItemCreateResult {
  const { sheet, shop, draft, itemId, stockRowId, users } = input;
  if (
    sheet.type !== "journal" ||
    sheet.codex?.version !== 1 ||
    sheet.codex.kind !== "entry"
  )
    return {
      ok: false,
      error: "Shop stock can only be created on a Campaign Codex Entry.",
    };
  if (!ITEM_ID.test(itemId) || !ITEM_ID.test(stockRowId))
    return { ok: false, error: "The item or stock-row identity is invalid." };
  if (input.existingItemIds?.includes(itemId))
    return {
      ok: false,
      error: "That item identity is already in use; try again.",
    };
  if (shop.stock.length >= MAX_STOCK_ROWS)
    return {
      ok: false,
      error: `A shop can contain at most ${MAX_STOCK_ROWS} stock rows.`,
    };
  if (shop.stock.some((row) => row.id === stockRowId))
    return {
      ok: false,
      error: "That stock-row identity is already in use; try again.",
    };

  const item = itemDocument(
    itemId,
    draft,
    ownershipForShopAudience(sheet, shop, users),
  );
  const stock: CodexShopStockRow = {
    id: stockRowId,
    item: { coll: "items", id: itemId },
    quantity: draft.quantity,
    ...(shop.mode === "shop" ? { unitPrice: priceText(draft.priceGp) } : {}),
    order: shop.stock.length,
  };
  const nextShop: CodexShopConfig = { ...shop, stock: [...shop.stock, stock] };
  const nextCodex = { ...sheet.codex, shop: nextShop };

  return {
    ok: true,
    item,
    stock,
    ops: [
      { kind: "create", coll: "items", data: item },
      {
        kind: "update",
        ref: { coll: "journals", id: sheet._id },
        diff: { codex: nextCodex as unknown as Json },
      },
    ],
  };
}

export type CodexItemPatch = Partial<
  Pick<
    CodexItemDraft,
    "name" | "description" | "weightLb" | "priceGp" | "quantity"
  >
>;

export type CodexItemUpdateResult =
  { ok: true; op: Op } | { ok: false; error: string };

/** Build a minimal update while preserving unrelated PF1e item fields and description metadata. */
export function codexItemUpdateOp(
  ref: DocRef,
  item: ItemDocument,
  patch: CodexItemPatch,
): CodexItemUpdateResult {
  const diff: Record<string, Json | null> = {};
  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (name.length === 0 || name.length > 128)
      return {
        ok: false,
        error: "Item name must be between 1 and 128 characters.",
      };
    diff.name = name;
  }
  if (patch.description !== undefined) {
    if (patch.description.length > MAX_ITEM_DESCRIPTION_LENGTH)
      return {
        ok: false,
        error: `Description must be at most ${MAX_ITEM_DESCRIPTION_LENGTH} characters.`,
      };
    const description = item.system.description;
    const block =
      typeof description === "object" &&
      description !== null &&
      !Array.isArray(description)
        ? description
        : null;
    diff["system.description"] =
      block === null
        ? patch.description.trim()
        : { ...block, value: patch.description.trim() };
  }
  if (patch.weightLb !== undefined) {
    if (
      !Number.isFinite(patch.weightLb) ||
      patch.weightLb < 0 ||
      patch.weightLb > MAX_ITEM_WEIGHT_LB
    )
      return { ok: false, error: "Weight must be a non-negative number." };
    diff["system.weight"] = patch.weightLb;
  }
  if (patch.priceGp !== undefined) {
    if (
      !Number.isFinite(patch.priceGp) ||
      patch.priceGp < 0 ||
      patch.priceGp > MAX_ITEM_PRICE_GP ||
      Math.abs(patch.priceGp * 100 - Math.round(patch.priceGp * 100)) > 1e-7
    )
      return {
        ok: false,
        error:
          "Price must be a supported non-negative GP amount with at most two decimal places.",
      };
    diff["system.value"] = patch.priceGp;
  }
  if (patch.quantity !== undefined) {
    if (
      !Number.isSafeInteger(patch.quantity) ||
      patch.quantity < 0 ||
      patch.quantity > MAX_ITEM_QUANTITY
    )
      return {
        ok: false,
        error: `Quantity must be a whole number from 0 to ${MAX_ITEM_QUANTITY}.`,
      };
    diff["system.quantity"] = patch.quantity;
  }
  if (Object.keys(diff).length === 0)
    return { ok: false, error: "No item changes were provided." };
  return { ok: true, op: { kind: "update", ref, diff } };
}

/** A manually authored PF1e item starts private; an embedded item's read rights cascade from its Actor. */
export function createActorInventoryItemOp(
  actor: ActorDocument,
  itemId: string,
  draft: CodexItemDraft,
): { ok: true; item: ItemDocument; op: Op } | { ok: false; error: string } {
  if (!ITEM_ID.test(itemId))
    return { ok: false, error: "The item identity is invalid." };
  if (actor.items.some((item) => item._id === itemId))
    return {
      ok: false,
      error: "That item identity is already on this character; try again.",
    };
  const item = itemDocument(itemId, draft, { default: OWNERSHIP_LEVELS.NONE });
  const op: Op = {
    kind: "create",
    coll: "items",
    parent: { coll: "actors", id: actor._id },
    data: item,
  };
  return { ok: true, item, op };
}

export function deleteActorInventoryItemOp(
  actorId: string,
  itemId: string,
): Op {
  return {
    kind: "delete",
    ref: { coll: "items", id: itemId, parent: { coll: "actors", id: actorId } },
  };
}

export function codexItemDescription(
  item: Pick<ItemDocument, "system">,
): string {
  const description = item.system.description;
  if (typeof description === "string") return description;
  if (
    typeof description !== "object" ||
    description === null ||
    Array.isArray(description)
  )
    return "";
  const value = description.value;
  return typeof value === "string" ? value : "";
}
