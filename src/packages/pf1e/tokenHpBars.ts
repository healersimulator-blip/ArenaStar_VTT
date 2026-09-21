/**
 * §2.2 item 1 (G-10a) — **token hit-point bars**.
 *
 * The bar is a presentation of the numbers the sheet already derives, never a second bookkeeping:
 * `deriveFromActorDocument` yields `hp`/`hpMax`/`tempHp`/`nonlethalDamage`, and the stage draws
 * exactly those, so a bar and the popup sheet cannot disagree.
 *
 * Hit points are also the one derived statistic **no effect can move** in this model, which is why
 * this module takes no combat context: `PF1E_MOD_KEYS` has no hit-point key, so an effect's
 * `ability.con` mod changes the modifier (and every DC and skill that uses it) while the authored
 * `hp`/`hpMax` stand — the derivation adjusts them only for Constitution *drain and damage*, which
 * are authored on the same document (`actor.ts:conHpPerDie`). The badge row
 * (`tokenBadgesFor`) is where the combat-home effect merge lives; a bar has nothing to merge.
 *
 * *Who* may see a bar is a world setting (`tokenHpBars`): `"gm"` (the default — the GM's own canvas
 * only), `"all"` (every replica), `"hover"` (only under the pointer). This module decides the first
 * two; `"hover"` is the same numbers with the canvas stage filtering by pointer position, because
 * hover is a pointer fact, not a data fact.
 *
 * Like the badges, the bars are presentation over data every replica already holds: a player whose
 * replica carries a monster's actor can read its hit points whatever the canvas draws (the D-260
 * authority note — fog and bars are table-trust, not information security).
 */
import type { ActorDocument, TokenDocument } from "../../core/documents";
import { deriveFromActorDocument } from "./actor";

/** Where a token's bar may appear (the `tokenHpBars` world setting). */
export type PF1eTokenHpBarMode = "gm" | "all" | "hover";

/** One token's bar: exactly the numbers the bar draws. */
export interface PF1eTokenHpBar {
  hp: number;
  hpMax: number;
  /** Temporary hit points on top of `hp` — a segment beside the lethal fill (H02/D-206). */
  tempHp: number;
  /** Nonlethal damage — its own thin track under the bar (CRB p.187). */
  nonlethalDamage: number;
}

/**
 * The bar for one token, or null when the token has no actor, the actor is gone, or the actor
 * authors no maximum (`hpMax < 1` — an unauthored stat block has nothing to show).
 */
export function tokenHpBarFor(
  token: Pick<TokenDocument, "_id" | "actorId">,
  actors: readonly ActorDocument[],
): PF1eTokenHpBar | null {
  if (!token.actorId) return null;
  const actor = actors.find((a) => a._id === token.actorId);
  if (actor === undefined) return null;
  const derived = deriveFromActorDocument(actor);
  if (!Number.isFinite(derived.hpMax) || derived.hpMax < 1) return null;
  return {
    hp: derived.hp,
    hpMax: derived.hpMax,
    tempHp: derived.tempHp,
    nonlethalDamage: derived.nonlethalDamage,
  };
}

/**
 * Token id → bar, the shape the canvas stage consumes in `syncTokens`. In the default `"gm"` mode
 * a player receives an empty map; `"all"` and `"hover"` hand the same numbers to every replica
 * (the stage is what hides a `"hover"` bar until the pointer arrives).
 */
export function tokenHpBarsMap(
  tokens: readonly Pick<TokenDocument, "_id" | "actorId">[],
  ctx: {
    actors: readonly ActorDocument[];
    mode: PF1eTokenHpBarMode;
    /** Whether this shell is the GM's — the `"gm"` mode's own gate. */
    isGM: boolean;
  },
): Map<string, PF1eTokenHpBar> {
  const out = new Map<string, PF1eTokenHpBar>();
  if (ctx.mode === "gm" && !ctx.isGM) return out;
  for (const token of tokens) {
    const bar = tokenHpBarFor(token, ctx.actors);
    if (bar !== null) out.set(token._id, bar);
  }
  return out;
}
