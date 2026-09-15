/**
 * M10 — hero orders: the pure model behind the Army Management Window's direct-target and
 * caster controls.
 *
 * The window speaks to players through orders only (`UnitDocument.orders.pending`, updated by
 * authorized embedded-doc Ops — §4A/§10). Everything the tactical/strategic rules actually do
 * with those orders lives in the loaded RulesModule: this file never adjudicates a rule. It
 * answers three presentation questions:
 *
 *  1. **Which orders does this campaign's module accept from controls?** `heroOrderCapabilities`
 *     reads `schema.orderTypes` for direct attacking and the optional §12 `orderVocabulary()`
 *     capability for casting, so a module without the capability (mass-battle-basic) shows no
 *     caster control instead of one that can only be refused later.
 *  2. **Whom may this army target?** `enemyTargetRows` mirrors the engine's own hostility and
 *     reachability facts at this scale — enemy = a different faction (D-182), and a unit with
 *     no `modelRange` has no living models to hit (M07/D-173's anchor rule), so it is counted
 *     and named rather than offered as a target.
 *  3. **What payload shape does a cast order need?** `castOrderFor` builds exactly the
 *     `spell_aoe` data the resolver parses (CRB p.214: a burst designates a point of origin,
 *     a cone/line shoots away from the caster), with every unusable input refused by name
 *     before an Op is submitted — the same "named refusal, never a silent fallback" contract
 *     the rest of the PF1e layer uses.
 *
 * Hero *identity* here is a label, not a rule: `strategicHeroMark` reads the same authored
 * facts the module's internal gate does (`type: "hero"`, `stats.hero`, a bound leader token) so
 * a player can pick the enemy hero out of a roster. Only the module decides behaviour.
 */
import type { RulesCastOption, RulesModule } from "../../core/rules";
import type { Order } from "../../core/strategic";
import type {
  ArmyDocument,
  FactionDocument,
  UnitDocument,
} from "../../core/strategic";

/** M10 — what the active module lets normal controls issue. */
export interface HeroOrderCapabilities {
  /** The module validates `attack` orders, so a direct target can be named. */
  directAttack: boolean;
  /** Castable spells the module advertises; empty ⇒ no caster controls. */
  casts: readonly RulesCastOption[];
}

/**
 * Capabilities of a resolved (or absent) rules module. Never throws: a null module — the
 * window's own "no rules resolved yet" state — has no capabilities, so the controls are
 * hidden rather than issued and refused.
 */
export function heroOrderCapabilities(
  rules: RulesModule | null | undefined,
): HeroOrderCapabilities {
  if (!rules) return { directAttack: false, casts: [] };
  const vocabulary = safeVocabulary(rules);
  return {
    directAttack: rules.schema.orderTypes.includes("attack"),
    casts: vocabulary,
  };
}

/**
 * A third-party package can advertise `orderVocabulary` and still throw inside it (§12 only
 * proves the method exists, that it is a function). A broken capability must degrade to "no
 * caster controls", never take the whole Orders tab down with it — the window still has to be
 * able to issue the move/hold/retreat orders that work.
 */
function safeVocabulary(rules: RulesModule): readonly RulesCastOption[] {
  if (typeof rules.orderVocabulary !== "function") return [];
  try {
    const vocabulary = rules.orderVocabulary();
    const casts = vocabulary?.casts;
    return Array.isArray(casts) ? casts : [];
  } catch {
    return [];
  }
}

/** One targetable enemy unit, as the direct-target select presents it. */
export interface HeroTargetRow {
  unitId: string;
  name: string;
  unitType: string;
  armyId: string;
  armyName: string;
  factionName: string;
  /** Authored strength (`stats.strength`); the roster's own figure, not a live model count. */
  strength: number;
  /** Display mirror of the module's hero gate — see `strategicHeroMark`. */
  hero: boolean;
}

/** M10 — the enemy roster a direct-target control offers. */
export interface HeroTargetList {
  targets: readonly HeroTargetRow[];
  /**
   * Enemy units with no `modelRange` — deployed nowhere, therefore unhittable at this
   * scale. Counted and named in the UI rather than silently dropped from the roster.
   */
  undeployed: number;
}

/**
 * The enemy units this army may shoot at. Hostility is the engine's own relation at this
 * scale (D-182: a different faction; `FactionDocument.allies` is not consulted by the mass
 * battle, so the control does not consult it either — a target the resolver would treat as
 * an enemy is always offered, and one it would not never is).
 */
export function enemyTargetRows(input: {
  armies: readonly ArmyDocument[];
  factions: readonly FactionDocument[];
  ownArmyId: string;
}): HeroTargetList {
  const own = input.armies.find((a) => a._id === input.ownArmyId);
  if (!own) return { targets: [], undeployed: 0 };
  const factionName = (id: string): string =>
    input.factions.find((f) => f._id === id)?.name ?? id;
  const targets: HeroTargetRow[] = [];
  let undeployed = 0;
  for (const army of input.armies) {
    if (army._id === own._id) continue;
    if (army.factionId === own.factionId) continue;
    for (const unit of army.units) {
      if (unit.modelRange === null || unit.modelRange === undefined) {
        undeployed += 1;
        continue;
      }
      targets.push({
        unitId: unit._id,
        name: unit.name,
        unitType: unit.type,
        armyId: army._id,
        armyName: army.name,
        factionName: factionName(army.factionId),
        strength: statNumber(unit.stats["strength"]) ?? 0,
        hero: strategicHeroMark(unit),
      });
    }
  }
  targets.sort(
    (a, b) => Number(b.hero) - Number(a.hero) || a.name.localeCompare(b.name),
  );
  return { targets, undeployed };
}

/**
 * The authored facts the module's hero gate reads (`type === "hero"`, `stats.hero === 1`, a
 * bound leader token). Presentation only — the engine owns the behaviour, and its gate is
 * `isHeroUnit` in `src/packages/massBattlePf1e.ts`, which the UI may not import (the mass
 * battle ships as a package, §12/D-086).
 */
export function strategicHeroMark(unit: UnitDocument): boolean {
  return (
    unit.type === "hero" ||
    unit.stats["hero"] === 1 ||
    (typeof unit.leaderTokenId === "string" && unit.leaderTokenId.length > 0)
  );
}

/** M10 — a hero melee order against a named enemy unit (direct targeting, B §4.1). */
export function directAttackOrder(targetUnitId: string): Order {
  return { kind: "attack", targetUnitId };
}

/** A built order, or the named reason the control cannot build one yet. */
export type HeroOrderBuild =
  { ok: true; order: Order } | { ok: false; reason: string };

const finite = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);

/** Round a payload coordinate so a re-deployed order compares equal across the wire. */
const round3 = (v: number): number => Math.round(v * 1000) / 1000;

/**
 * M10 — the `spell_aoe` order for the selected spell and aim point.
 *
 * `"point"` spells (circle/blast) designate a remote origin, so the payload carries `{x, y}`
 * in world feet (CRB p.214). `"direction"` spells (cone/line) start at the caster and shoot
 * away from it, so the payload carries the caster→aim vector — and a zero vector is refused
 * by name rather than defaulting to east, because "the caster is standing on the aim point"
 * is a GM question, not a fallback the software should answer.
 */
export function castOrderFor(input: {
  spellId: string;
  targeting: RulesCastOption["targeting"];
  from: { x: number; y: number };
  aim: { x: number; y: number };
}): HeroOrderBuild {
  if (typeof input.spellId !== "string" || input.spellId.length === 0) {
    return { ok: false, reason: "no spell selected" };
  }
  if (input.targeting === "point") {
    if (!finite(input.aim.x) || !finite(input.aim.y)) {
      return {
        ok: false,
        reason: "the point of origin needs finite numeric coordinates (feet)",
      };
    }
    return {
      ok: true,
      order: {
        kind: "custom",
        type: "spell_aoe",
        data: {
          spell: input.spellId,
          x: round3(input.aim.x),
          y: round3(input.aim.y),
        },
      },
    };
  }
  if (!finite(input.from.x) || !finite(input.from.y)) {
    return {
      ok: false,
      reason:
        "the caster's position is unreadable, so no direction can be derived",
    };
  }
  if (!finite(input.aim.x) || !finite(input.aim.y)) {
    return {
      ok: false,
      reason: "the aim point needs finite numeric coordinates (feet)",
    };
  }
  const dirX = round3(input.aim.x - input.from.x);
  const dirY = round3(input.aim.y - input.from.y);
  if (dirX === 0 && dirY === 0) {
    return {
      ok: false,
      reason:
        "the caster and the aim point share an anchor — pick an aim point away from the caster",
    };
  }
  return {
    ok: true,
    order: {
      kind: "custom",
      type: "spell_aoe",
      data: { spell: input.spellId, dirX, dirY },
    },
  };
}

/**
 * M10 — one-line label for a pending order in the queue readout. `attack` and `spell_aoe`
 * carried no text before (the queue showed a bare kind), which made a hero order
 * indistinguishable from a doctrine order in the window.
 */
export function orderLabel(
  order: Order,
  nameOf: (unitId: string) => string,
): string {
  switch (order.kind) {
    case "move":
      return `move → ${order.path.length} wp (${order.pace})`;
    case "attack":
      return `attack → ${nameOf(order.targetUnitId)}`;
    case "retreat":
      return `retreat → (${round3(order.toward.x)}, ${round3(order.toward.y)})`;
    case "hold":
      return `hold (${order.stance})`;
    case "custom": {
      if (order.type !== "spell_aoe") return `custom (${order.type})`;
      const data =
        typeof order.data === "object" && order.data !== null
          ? (order.data as Record<string, unknown>)
          : {};
      const spell =
        typeof data.spell === "string" ? data.spell : "default spell";
      return finite(data.dirX) && finite(data.dirY)
        ? `cast ${spell} → dir (${data.dirX}, ${data.dirY})`
        : `cast ${spell} → (${data.x}, ${data.y})`;
    }
    case "formation":
      return `formation (${order.formation})`;
    case "supply":
      return `supply (${order.action})`;
    default:
      return (order as { kind: string }).kind;
  }
}

/** A numeric stat read honestly: anything non-finite is absent, not zero-filled. */
function statNumber(v: unknown): number | null {
  return finite(v) ? v : null;
}
