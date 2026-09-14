/**
 * F01/F03 — build RollHighlightRequest payloads from roll-card documents.
 * Chat cards carry the semantic facts (initiator, targets, area); the App
 * resolves them against the active scene (token existence, real grid px/ft,
 * camera). Pure builders, one source for both card kinds.
 */

import type { RollLedger } from "../../packages/pf1e/rollLedger";
import type { PendingRoll } from "../../packages/pf1e/pendingRoll";
import type { RollHighlightRequest } from "../../client/rollHighlight";

export function highlightRequestFromLedger(
  ledger: RollLedger,
  kind: "initiator" | "target" | "area",
  clickedId: string | null,
  fadeSec: number,
): RollHighlightRequest {
  if (kind === "initiator")
    return {
      kind,
      tokenId: ledger.initiator.tokenId,
      actorId: ledger.initiator.actorId,
      area: null,
      affectedTokenIds: [],
      fadeSec,
    };
  if (kind === "target") {
    const t =
      ledger.targets?.find((t) => t.actorId === clickedId || t.tokenId === clickedId) ?? null;
    return {
      kind,
      tokenId: t?.tokenId ?? null,
      actorId: t?.actorId ?? clickedId,
      area: null,
      affectedTokenIds: [],
      fadeSec,
    };
  }
  return {
    kind: "area",
    tokenId: null,
    actorId: null,
    area: ledger.area
      ? {
          shape: ledger.area.shape,
          origin: ledger.area.origin,
          radiusFt: ledger.area.radiusFt,
          direction: ledger.area.direction,
        }
      : null,
    affectedTokenIds: ledger.area ? [...ledger.area.affectedTokenIds] : [],
    fadeSec,
  };
}

export function highlightRequestFromPending(
  pending: PendingRoll,
  kind: "initiator" | "target" | "area",
  clickedId: string | null,
  fadeSec: number,
): RollHighlightRequest {
  if (kind === "initiator")
    return {
      kind,
      tokenId: pending.initiator.tokenId,
      actorId: pending.initiator.actorId,
      area: null,
      affectedTokenIds: [],
      fadeSec,
    };
  if (kind === "target")
    return {
      kind,
      tokenId: pending.target.tokenId,
      actorId: pending.target.actorId ?? clickedId,
      area: null,
      affectedTokenIds: [],
      fadeSec,
    };
  return {
    kind: "area",
    tokenId: null,
    actorId: null,
    area: pending.area
      ? {
          shape: pending.area.shape,
          origin: pending.area.origin,
          radiusFt: pending.area.radiusFt,
          direction: pending.area.direction,
        }
      : null,
    affectedTokenIds: [],
    fadeSec,
  };
}
