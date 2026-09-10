/**
 * **Token condition badges (E06, D-147).**
 *
 * The pure half of token condition rendering: which badges a token shows, derived on read from
 * the two effect homes (E01) — the linked combatant's `flags.core.effects` (the combat copy
 * wins id collisions) and, when the token has an `actorId`, the actor's embedded
 * `actor.effects`. Derivation semantics never persist: the canvas consumes the returned list
 * straight from the replica on every refresh, so applying, suppressing or expiring an effect
 * changes (or clears) the badges with no invalidation step.
 *
 * Display rules:
 * - Suppressed (disabled) effects are OFF (the E02 editor semantic) — no badge.
 * - Effects whose payload names an SRD condition (`payload.condition`, E03) sort first under
 *   the condition label; every other effect follows under its document name.
 * - `code` is the chip's deterministic abbreviation and `tint` its stable color, so a badge
 *   does not flicker between refreshes.
 * - The model returns every badge; the renderer caps how many chips fit (stage.ts).
 */
import type {
  ActorDocument,
  CombatDocument,
  EffectDocument,
  TokenDocument,
} from "../../core/documents";
import { readTacticalEffect, type PF1eEffectPayload } from "./effects";
import { combatantEffectsRecord } from "./effectOps";

export type TokenBadge = {
  effectId: string;
  label: string;
  code: string;
  tint: number;
  /** True when the payload names an SRD condition (the E03 library). */
  condition: boolean;
};

/** Chip abbreviation: word initials ("Flat-Footed" → "FF"); first two letters of one word ("Shaken" → "SH"). */
export function conditionCode(label: string): string {
  const words = label.split(/[^A-Za-z0-9]+/).filter((w) => w.length > 0);
  const first = words[0];
  if (!first) return "??";
  if (words.length === 1) {
    return (first.length > 1 ? first.slice(0, 2) : first + first).toUpperCase();
  }
  const second = words[1];
  if (!second) return first.slice(0, 2).toUpperCase();
  return (first[0] ?? "?").toUpperCase() + (second[0] ?? "?").toUpperCase();
}

/** Deterministic chip tint from the label, so a badge keeps its color between refreshes. */
const PALETTE = [
  0xd04a4a, // red
  0xe6b800, // amber
  0x4aa8d0, // blue
  0x59b35c, // green
  0xb35cd0, // purple
  0xd08a4a, // orange
] as const;

export function badgeTint(label: string): number {
  let h = 0;
  for (const ch of label) {
    h = (h * 31 + (ch.codePointAt(0) ?? 0)) & 0xffff;
  }
  const tint = PALETTE[h % PALETTE.length] ?? 0xd04a4a;
  return tint;
}

function badgeOf(
  id: string,
  name: string,
  payload: PF1eEffectPayload,
): TokenBadge {
  const label = payload.condition ?? name;
  return {
    effectId: id,
    label,
    code: conditionCode(label),
    tint: badgeTint(label),
    condition: payload.condition !== undefined,
  };
}

/** Badges from one embedded-effect record, in record order; invalid and suppressed docs are skipped. */
export function collectBadges(
  record: Record<string, EffectDocument>,
): TokenBadge[] {
  const out: TokenBadge[] = [];
  for (const [id, doc] of Object.entries(record)) {
    const r = readTacticalEffect(id, doc);
    if (!r.ok) continue;
    if (r.value.disabled) continue;
    out.push(badgeOf(id, r.value.name, r.value.payload));
  }
  return out;
}

function badgesFromActor(actor: ActorDocument | undefined): TokenBadge[] {
  const embedded = Array.isArray(actor?.effects) ? actor.effects : [];
  const out: TokenBadge[] = [];
  for (const doc of embedded) {
    const id = String(doc._id ?? "");
    const r = readTacticalEffect(id, doc);
    if (!r.ok) continue;
    if (r.value.disabled) continue;
    out.push(badgeOf(id, r.value.name, r.value.payload));
  }
  return out;
}

/**
 * Every badge a token shows: the linked combatant's combat-home effects first (the combat copy
 * wins id collisions, per E01), then the linked actor's embedded home minus those duplicates.
 * When several encounters claim the same token, an under-way one (round ≥ 1) wins.
 */
export function tokenBadgesFor(
  token: Pick<TokenDocument, "_id" | "actorId">,
  ctx: {
    actors: readonly ActorDocument[];
    combats: readonly CombatDocument[];
  },
): TokenBadge[] {
  const merged = new Map<string, TokenBadge>();

  const claims: Array<{
    round: number;
    record: Record<string, EffectDocument>;
  }> = [];
  for (const combat of ctx.combats) {
    const member = combat.combatants.find((c) => c.tokenId === token._id);
    if (member)
      claims.push({
        round: combat.round,
        record: combatantEffectsRecord(member),
      });
  }
  const home = claims.find((c) => c.round >= 1) ?? claims[0];
  if (home) {
    for (const badge of collectBadges(home.record))
      merged.set(badge.effectId, badge);
  }

  if (token.actorId) {
    const actorDoc = ctx.actors.find((a) => a._id === token.actorId);
    for (const badge of badgesFromActor(actorDoc)) {
      if (!merged.has(badge.effectId)) merged.set(badge.effectId, badge);
    }
  }

  const all = [...merged.values()];
  return [
    ...all.filter((b) => b.condition),
    ...all.filter((b) => !b.condition),
  ];
}

/** Token id → badges, the shape the canvas stage consumes in `syncTokens`. */
export function tokenBadgesMap(
  tokens: readonly Pick<TokenDocument, "_id" | "actorId">[],
  ctx: {
    actors: readonly ActorDocument[];
    combats: readonly CombatDocument[];
  },
): Map<string, TokenBadge[]> {
  const out = new Map<string, TokenBadge[]>();
  for (const token of tokens) {
    const badges = tokenBadgesFor(token, ctx);
    if (badges.length > 0) out.set(token._id, badges);
  }
  return out;
}
