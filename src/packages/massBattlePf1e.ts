/**
 * Pathfinder 1e Mass Battles Reference System ("pf1e-mass-battles").
 * Integrates d20 attack routines, DR/SR, spatial envelopment, pack-driven AOE spells,
 * player hero participation, and detailed combat analytics.
 */
import {
  sceneCellFeet,
  type RulesCastOption,
  type RulesContext,
  type RulesModule,
  type RulesOrderVocabulary,
  type UnitView,
} from "../core/rules";
import type { PRNG } from "../core/sim";
import type { ModelPool, Order } from "../core/strategic";
import { ModelStatus } from "../core/strategic";
import { err, ok, type OkOrErr } from "../core/result";
import { PF1E_MODEL_SCHEMA, PF1eProfileRegistry } from "./pf1e/schema";
import { buildUnitProfiles, seedPF1ePool } from "./pf1e/deploySeed";
import {
  pf1eRngFromPrng,
  resetTurnAoOs,
  resolvePF1eAttacks,
  resolvePF1eHealing,
  type PF1eRng,
} from "./pf1e/combatEngine";
import { markPF1eFlanking } from "./pf1e/envelopment";
import {
  cellAt,
  cellsAlongSegment,
  footprintCells,
  naturalReachSquares,
  threatenedCells,
} from "./pf1e/geometry";
import {
  aooRefusal,
  createInterruptQueue,
  queueMovementAoOs,
  resolveNextInterrupt,
} from "./pf1e/interrupts";
import type { PF1eCell } from "./pf1e/targeting";
import { resolvePF1eAOESpell } from "./pf1e/spells";
import { planPF1eStride, type PF1eStridePace } from "./pf1e/stride";
import {
  parsePackSpellOrder,
  PF1E_PACK_MASS_SPELL_MIRRORS,
  spellRangeFeet,
} from "./pf1e/spellPacks";
import { spellSaveDc } from "./pf1e/casting";
import { applyHeroLeadershipAuras } from "./pf1e/heroBridge";
import { deriveFromDocuments, parsePF1eActorSystem } from "./pf1e/actor";
import {
  PF1eBattleAnalyticsCollector,
  type UnitAnalyticsSummary,
} from "./pf1e/analytics";
import { SpatialGrid } from "../core/spatialGrid";
import { hasLineOfEffect, firstMoveBlock } from "../core/detection";

/**
 * A spell the mass-battle module can fire: the pack entry plus its verified level. Both halves
 * come from `PF1E_PACK_MASS_SPELL_MIRRORS` in `spellPacks.ts` — the one table that says which
 * content the resolver executes. M15 grew the shipped pack to 40 spells; four of them are
 * automated, and the pack's `system.automation` declaration is what keeps that boundary honest:
 * an entry that claims "automated" without a payload the parser accepts fails
 * `parsePackSpellOrder`, and the sync test refuses any pack whose declaration and block disagree.
 */
export interface PF1eMassSpellDef {
  entry: Readonly<Record<string, unknown>>;
  /**
   * The class level used for `spellSaveDc` (CRB p.283: "Level sorcerer/wizard 3" for Fireball,
   * verified in D-151's R02 transcription). The pack's `level` table is content the reference
   * system does not read — the pack ships a known-buggy one — so the number lives here and the
   * sync test pins the pack's `sorcererWizard` entry against it.
   */
  level: number;
}

/**
 * The spells the module can fire, keyed by the pack entry id an order names in
 * `data.spell` (default `fireball`). Every entry ships in `pf1e-core/packs/spells.json`;
 * the levels are the verified CRB constants, not the pack's `level` table (D-151).
 */
export const PF1E_MASS_SPELLS: Readonly<Record<string, PF1eMassSpellDef>> =
  PF1E_PACK_MASS_SPELL_MIRRORS;

/** Orders that omit `data.spell` cast this spell (backwards compatibility). */
export const DEFAULT_MASS_SPELL_ID = "fireball";

/** M10 — pack-driven spell catalog for caster order UIs (id, display name, AoE shape). */
export function massBattleSpellCatalog(): Array<{
  id: string;
  spellName: string;
  shape: string;
}> {
  return Object.entries(PF1E_MASS_SPELLS).map(([id, def]) => {
    let spellName = id;
    let shape = "circle";
    const probe = parsePackSpellOrder({ entry: def.entry, casterLevel: 1 });
    if (probe.ok && probe.order) {
      spellName = probe.order.spellName;
      shape = probe.order.shape;
    }
    return { id, spellName, shape };
  });
}

/**
 * The unit-type stat lines the schema advertises. Movement points are the module's own
 * mass-battle abstraction (work-plan schema), resolved against the scene grid: a move
 * point covers one grid cell of `ctx.grid.distance` feet. Single source of truth — the
 * schema's `unitTypes` block below is this map, and the move phase reads from it.
 */
const PF1E_UNIT_TYPE_STATS = {
  infantry: { move: 4, ac: 16, bab: 6, drVal: 0 },
  cavalry: { move: 8, ac: 18, bab: 8, drVal: 2 },
  artillery: { move: 2, ac: 12, bab: 4, drVal: 0 },
  hero: { move: 6, ac: 20, bab: 11, drVal: 5 },
} as const;

/**
 * A formation clipped by a movement-blocking wall stops this far short of it (feet), so
 * the next turn's movement still starts on the open side of the wall — the strict
 * crossing test would otherwise let a segment beginning exactly on the wall through.
 */
const MOVE_BLOCK_EPSILON = 1e-3;

/**
 * M05 — the `hold` stances this module gives a mechanical meaning to. Anything else is
 * refused at issue rather than queued and then silently ignored: a stance nothing resolves is
 * a message the GM believes, which is worse than a rejection.
 *  • `defend` — CRB p.185 Defensive Combat: "you gain a +2 dodge bonus to AC and CMD" and
 *    take "a –4 penalty on all attacks";
 *  • `hold` / `screen` — stand fast in place. Not inert: the order *is* the unit's order for
 *    the turn, so it outranks the doctrine's auto-march (D-223) and cancels an in-progress
 *    march, which is exactly what a screen line is for at this scale.
 */
const PF1E_HOLD_STANCES = ["hold", "screen", "defend"] as const;

/** M05 — the attack modes this module resolves (anything else is refused by name). */
const PF1E_ATTACK_MODES = ["melee", "shot"] as const;

/** Move-order path cap, matching the reference package's DoS guard (massBattleBasic). */
const MAX_MOVE_WAYPOINTS = 12;

export interface MassBattlePf1eOptions {
  /**
   * Overrides the entry of the default spell (defaults to the mirrored pf1e-core
   * Fireball). Injectable so the cone/line paths are testable before any such spell
   * ships in a pack, and so the reference system stays pack-driven otherwise.
   */
  spellEntry?: Readonly<Record<string, unknown>> | undefined;
}

/** Read `data.spell` (the pack entry id an order names); absent → default spell. */
function payloadSpellId(data: unknown): string {
  const rec =
    typeof data === "object" && data !== null && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : null;
  const id = rec?.spell;
  return typeof id === "string" && id.length > 0 ? id : DEFAULT_MASS_SPELL_ID;
}

export function createMassBattlePf1e(
  opts: MassBattlePf1eOptions = {},
): RulesModule {
  const registry = new PF1eProfileRegistry();
  // The spatial hash buckets by the **scene's** cell feet (P01, Gap List §2.15): the
  // old fixed 5 was a second, independent scale constant next to `ctx.grid.distance`,
  // and the flanking pass below reasons in whole squares of exactly that size. The
  // hash is re-created below when a scene's grid distance differs from the last turn's.
  let grid = new SpatialGrid(5);
  // Strategic turns resolve one at a time, and each drains its interrupt queue before it
  // returns, so this counter only *labels* the turn's queue — no interrupt outlives its
  // turn (P06/D-184). `RulesContext` carries no turn number, so the module counts its own
  // calls; like the analytics collector it is module-lifetime state and resets when a
  // SimWorker restarts, which costs nothing because each queue is turn-local anyway.
  let strategicTurn = 0;
  // Campaign-lifetime analytics: one collector per module instance, NOT per turn — that is
  // what lets `forecast` answer with real accumulated totals (M11). Caveat: a SimWorker
  // restart starts a fresh collector, so totals only cover this module instance's turns.
  const analytics = new PF1eBattleAnalyticsCollector();

  // The module's spell list is the shipped registry; `opts.spellEntry` overrides the
  // default spell's entry (the test seam), leaving every other spell untouched.
  const spells: Record<string, PF1eMassSpellDef> = { ...PF1E_MASS_SPELLS };
  const defaultDef = spells[DEFAULT_MASS_SPELL_ID];
  if (opts.spellEntry && defaultDef) {
    spells[DEFAULT_MASS_SPELL_ID] = {
      entry: opts.spellEntry,
      level: defaultDef.level,
    };
  }

  // Each spell's shape decides what a well-formed order looks like, so probe it once at
  // creation. An unparseable entry is not validated here — resolveTurn names the pack
  // issue per cast; it just defaults the shape to circle for validation purposes.
  // The same probe answers M10's control question (`orderVocabulary`), so the caster
  // dropdown a player sees and the payload the resolver demands cannot drift apart: both
  // read `spellShapes`/`castVocabulary`, built from one pass over the registry.
  const spellShapes = new Map<string, string>();
  const castVocabulary: RulesCastOption[] = [];
  for (const [id, def] of Object.entries(spells)) {
    const probe = parsePackSpellOrder({ entry: def.entry, casterLevel: 1 });
    const shape = probe.ok && probe.order ? probe.order.shape : "circle";
    spellShapes.set(id, shape);
    castVocabulary.push({
      id,
      label:
        probe.ok && probe.order && probe.order.spellName.length > 0
          ? probe.order.spellName
          : id,
      // Cones and lines start at the caster and take an aim direction (CRB p.214);
      // every other shipped shape designates a remote point of origin.
      targeting: shape === "cone" || shape === "line" ? "direction" : "point",
    });
  }
  Object.freeze(castVocabulary);

  const subPhases = [
    "move",
    "heal",
    "shoot",
    "melee",
    "spell",
    "morale",
  ] as const;

  const module: RulesModule = {
    schema: {
      version: "1.0.0",
      modelColumns: PF1E_MODEL_SCHEMA,
      unitTypes: PF1E_UNIT_TYPE_STATS as unknown as Record<
        string,
        import("../core/documents").Json
      >,
      orderTypes: ["move", "attack", "custom", "hold", "retreat"],
      subPhases: [...subPhases],
    },

    // M10 — the caster control vocabulary. Registry-driven (so the `spellEntry` test seam
    // and any future pack addition show up without touching UI code), and deliberately
    // silent about who may cast: casting eligibility at this scale is authored content
    // (M16/M18's class/spell tables), and `validateOrder`/`resolveTurn` own the refusals.
    orderVocabulary(): RulesOrderVocabulary {
      return { casts: castVocabulary };
    },

    // M05 — the module validates exactly the orders it executes, and refuses the rest by
    // name. An accepted order that nothing resolves is the worst thing a rules package can do:
    // it occupies the unit's queue, the report stays silent, and the GM has nothing to re-read.
    // `mass-battle-basic` has always refused this way; the PF1e module now matches it, and the
    // move/pace checks here are the same rules `planPF1eStride` applies at resolve time — so a
    // control can surface them before an order is issued instead of after a turn is resolved.
    validateOrder(_ctx: RulesContext, _unit: UnitView, order: Order): OkOrErr {
      switch (order.kind) {
        case "move": {
          if (order.path.length === 0) return err("move: empty path");
          if (order.path.length > MAX_MOVE_WAYPOINTS)
            return err(
              `move: path too long (max ${MAX_MOVE_WAYPOINTS} waypoints)`,
            );
          for (const p of order.path) {
            if (!Number.isFinite(p.x) || !Number.isFinite(p.y))
              return err("move: NaN waypoint");
          }
          if (
            order.pace !== "march" &&
            order.pace !== "run" &&
            order.pace !== "charge"
          )
            return err(`move: unknown pace "${String(order.pace)}"`);
          // CRB p.188: a run and a charge are each "in a straight line". Checked here as well
          // as in the stride so a curved order never enters a queue at all.
          if (
            (order.pace === "run" || order.pace === "charge") &&
            order.path.length > 1
          )
            return err(
              `move: a ${order.pace} is a straight line (CRB p.188) — the order names ${order.path.length} destinations`,
            );
          return ok;
        }
        case "attack": {
          if (!order.targetUnitId) return err("attack: missing targetUnitId");
          if (
            order.mode !== undefined &&
            !PF1E_ATTACK_MODES.includes(order.mode as (typeof PF1E_ATTACK_MODES)[number])
          )
            return err(
              `attack: this module resolves no "${order.mode}" attack mode (it routes on the unit's weapon: melee, or shot when the profile is ranged)`,
            );
          return ok;
        }
        case "hold":
          return PF1E_HOLD_STANCES.includes(
            order.stance as (typeof PF1E_HOLD_STANCES)[number],
          )
            ? ok
            : err(
                `hold: unknown stance "${order.stance}" — this module gives a meaning to ${PF1E_HOLD_STANCES.map((x) => `"${x}"`).join(", ")}`,
              );
        case "formation":
        case "supply":
          return err(
            `${order.kind}: the PF1e mass-battle module resolves no ${order.kind} orders (frontage is set at deploy; supply is not simulated at this scale)`,
          );
        case "custom": {
          if (order.type !== "spell_aoe")
            return err(
              `custom: no "${order.type}" order in this module — the PF1e mass battles execute spell_aoe casts`,
            );
          const spellId = payloadSpellId(order.data);
          if (!spells[spellId])
            return err(`spell_aoe: unknown spell "${spellId}"`);
          const shape = spellShapes.get(spellId) ?? "circle";
          const payload = parseSpellAoePayload(shape, order.data);
          return payload.ok ? ok : err(`spell_aoe: ${payload.message}`);
        }
        case "retreat":
          return Number.isFinite(order.toward.x) &&
            Number.isFinite(order.toward.y)
            ? ok
            : err("retreat: NaN destination");
        default:
          return err(
            `order: this module executes no "${String((order as { kind: string }).kind)}" orders`,
          );
      }
    },

    resolveTurn(ctx, pool, units, orders, rng, emit): void {
      // Label this turn's interrupt queue. Counted at the top, not the end, so an early
      // return in a later sub-phase can never leave two turns sharing a label.
      strategicTurn += 1;

      // M06/§2.11 — the once-per-round spell-resistance overcome cache ("resistance is
      // overcome once per spell per round"): fresh every turn, keyed casterIdx:targetIdx,
      // consumed by every pack cast this turn.
      const srRoundCache = new Set<string>();

      // One grid cell in feet — the scene's authored grid distance (P01: scene metadata,
      // not constants), with the standard 5-ft fallback. Drives the movement budget
      // (D-173), reach (D-177/D-180), the spatial hash's buckets and the flanking pass
      // (M04/D-182) — one scale, derived in one place (`sceneCellFeet`).
      const cellFeet = sceneCellFeet(ctx.grid.distance);

      // M05 — the authored difficult squares for this scene, keyed `col,row` (the same key
      // form the threat sets below use). `ctx.terrain` is null when the scene authors no
      // ground, which is a NAMED default rather than an empty-but-real terrain: with it the
      // walk prices exactly what it always did, and nothing pretends rough ground was judged.
      const difficultCells = new Set<string>();
      for (const cell of ctx.terrain?.difficultCells ?? [])
        difficultCells.add(`${cell.col},${cell.row}`);

      // M05 — a unit that charged this turn carries the charge's combat modifiers into the
      // melee phase: +2 on the attack roll and −2 AC until its next turn (CRB p.183). Turn
      // local by construction: the AC write is undone next round by the profile reseed that
      // already governs the cleave penalty (D-178), and this set is rebuilt every turn.
      const chargedUnits = new Set<string>();
      if (grid.cellSize !== cellFeet) grid = new SpatialGrid(cellFeet);
      // F02 — snapshot of pre-move positions for simultaneous cover/flanking (faithful simultaneous reading)
      let simultaneousStartXs: Float32Array | null = null;
      let simultaneousStartYs: Float32Array | null = null;

      // ── natural reach per unit, in feet at this scale (P02, D-180). Table 8-4's reach
      // is a per-size figure, not a constant: "Creatures that take up more than 1 square
      // typically have a natural reach of 10 feet or more, meaning that they can reach
      // targets even if they aren't in adjacent squares" (AoN Rules ID 179). Reach is
      // carried in **squares** and multiplied by the scene's cell feet, so D-177's
      // scale-relative reading survives — one square of reach is `cellFeet` whether the
      // scene says 5 ft or 10 ft. The size comes from the unit's bound leader actor (the
      // M07 seam); a unit with none keeps the one-square Medium default, so an army
      // deployed without actor data resolves exactly as it did before.
      const reachSquaresByUnitIdx = units.map(
        (u) => reachSquaresFromLeaderActor(ctx.leaderActors[u.id]) ?? 1,
      );
      const reachFeetByUnitIdx = reachSquaresByUnitIdx.map(
        (squares) => squares * cellFeet,
      );
      const factionByUnitIdx = units.map((u) => u.factionId);
      const sizeByUnitIdx = units.map((u) =>
        sizeFromLeaderActor(ctx.leaderActors[u.id]),
      );

      // Profiles + derived pool columns (§1.3/§1.4). Interned from a deterministically
      // sorted unit list, so `profileIdx` values written into the pool stay valid across
      // turns, checkpoints and SimWorker restarts. Seeding also refreshes per-turn state:
      // the AoO budget resets (SRD: your attacks of opportunity refresh at the start of
      // your turn) and save/AC columns are rewritten before leadership auras are added,
      // which is what keeps an aura from stacking once per model per turn.
      const profiles = buildUnitProfiles(units, registry);
      seedPF1ePool(pool, units, profiles);

      // ── attacks of opportunity (P06, D-183 budget / D-184 queue). Budgets refresh here, at the
      // top of the turn and before anything moves: seedPF1ePool has just written every
      // model's `aooUsed` back to 0 (SRD: "your attacks of opportunity refresh at the start
      // of your turn"), and `resetTurnAoOs` names that reset for the models a unit covers —
      // the same call the tactical layer's owner-turn reset represents. Budgets must be
      // fresh *before* the march below, because a unit that provokes while moving is
      // reacting in the same turn it is spending its own budget in.
      resetTurnAoOs(pool, livingModelIndices(pool, units));

      // F02 — simultaneous regime check (world-settings or turnMode)
      const simultaneous =
        ctx.turnMode === "simultaneous" ||
        (ctx.worldSettings as Record<string, unknown>)
          ?.strategicSimultaneous === true;

      // F02 — squad fan-out: an order keyed by squadId expands to every unit in that squad (no new doc type)
      // Per-unit orders win (do not overwrite). SquadId is the UnitView.squadId tag (ArmyWindow squadId).
      {
        const expanded = new Map<
          string,
          import("../core/strategic").OrderQueue
        >(orders as Map<string, import("../core/strategic").OrderQueue>);
        for (const [key, queue] of orders.entries()) {
          const isUnit = units.some((u) => u.id === key);
          if (isUnit) continue;
          const members = units.filter(
            (u) =>
              (u as unknown as { squadId?: string | null }).squadId === key,
          );
          if (members.length === 0) continue;
          for (const m of members)
            if (!expanded.has(m.id)) expanded.set(m.id, queue);
          expanded.delete(key);
        }
        // Rebind the local `orders` binding for the rest of resolveTurn
        (
          orders as unknown as Map<
            string,
            import("../core/strategic").OrderQueue
          >
        ).clear();
        for (const [k, v] of expanded.entries())
          (
            orders as unknown as Map<
              string,
              import("../core/strategic").OrderQueue
            >
          ).set(k, v);
      }

      // ── G-04/D-223 — Combat_Resolver_5 doctrine mode (world setting
      // `strategicDoctrine`). The reference's `stepRound` runs `moveUnits(side)`
      // — EVERY unit of the army marches on the nearest enemy under its standing
      // behaviour, then fights what it reaches — so the GM never hand-drives one
      // token per turn. Here that becomes **order synthesis**: an un-ordered
      // unit whose doctrine is "advance" (the reference's standing default) gets
      // a contact-tested order materialised in the same map the phases already
      // read, so walls, the AoO queue, morale and the report all ride the
      // existing machinery unchanged:
      //   • in contact (front models within own natural reach of an enemy
      //     model) ⇒ attack order on the nearest enemy unit;
      //   • otherwise ⇒ march order toward the nearest living enemy model,
      //     stopping just outside own reach (the approach way-point; contact
      //     flips to an attack next turn);
      //   • doctrine "hold" ⇒ nothing (the unit stands).
      // Synthesised orders are honest artefacts: each is announced on the
      // ledger channel with `issuedBy: "doctrine"` so a report can never
      // confuse an autonomy with a GM order. Units with any queued order are
      // untouched — orders still outrank doctrine, exactly as CM1's command
      // channel overrides nearest-enemy doctrine in the reference.
      const doctrineMode =
        (ctx.worldSettings as Record<string, unknown>)?.strategicDoctrine ===
        true;
      if (doctrineMode) {
        // Living models per unit index (one scan for the whole synthesis).
        const livingByUnit: number[][] = units.map((u) => {
          const indices: number[] = [];
          const [start, end] = u.modelRange ?? [0, 0];
          for (let i = start; i < end && i < pool.count; i++) {
            if (((pool.status[i] ?? 0) & ModelStatus.dead) === 0)
              indices.push(i);
          }
          return indices;
        });
        for (let ui = 0; ui < units.length; ui++) {
          const unit = units[ui];
          if (!unit) continue;
          const queue = orders.get(unit.id);
          if (queue?.active || (queue?.pending?.length ?? 0) > 0) continue;
          if (unit.doctrine === "hold") continue;
          const ownLiving = livingByUnit[ui] ?? [];
          if (ownLiving.length === 0) continue;
          const anchor = anchorPosition(pool, unit);
          if (anchor === null) continue;
          // Nearest living enemy by anchor distance; engage the same unit whose
          // models stand closest (one pass keeps both honest).
          let nearest: {
            unit: UnitView;
            idx: number;
            dAnchor: number;
            dMin: number;
          } | null = null;
          for (let oi = 0; oi < units.length; oi++) {
            if (oi === ui) continue;
            const other = units[oi];
            if (!other || other.factionId === unit.factionId) continue;
            const otherLiving = livingByUnit[oi] ?? [];
            if (otherLiving.length === 0) continue;
            const otherAnchor = anchorPosition(pool, other);
            if (otherAnchor === null) continue;
            const dAnchor = Math.hypot(
              otherAnchor.x - anchor.x,
              otherAnchor.y - anchor.y,
            );
            let dMin = Infinity;
            let dMinIdx = otherLiving[0] ?? 0;
            for (const a of ownLiving) {
              const ax = pool.x[a] ?? 0;
              const ay = pool.y[a] ?? 0;
              for (const b of otherLiving) {
                const d = Math.hypot(
                  (pool.x[b] ?? 0) - ax,
                  (pool.y[b] ?? 0) - ay,
                );
                if (d < dMin) {
                  dMin = d;
                  dMinIdx = b;
                }
              }
            }
            if (nearest === null || dAnchor < nearest.dAnchor)
              nearest = { unit: other, idx: dMinIdx, dAnchor, dMin };
          }
          if (nearest === null) continue;
          const reachFt = reachFeetByUnitIdx[ui] ?? cellFeet;
          if (nearest.dMin <= reachFt) {
            orders.set(unit.id, {
              issuedBy: "doctrine",
              issuedTurn: strategicTurn,
              pending: [{ kind: "attack", targetUnitId: nearest.unit.id }],
            });
            emit({
              subPhase: "melee",
              type: "doctrine-engage",
              unitId: unit.id,
              targetUnitId: nearest.unit.id,
              at: { x: anchor.x, y: anchor.y },
              text: `${unit.name} engages ${nearest.unit.name} (doctrine)`,
              data: {
                kind: "doctrine",
                action: "engage",
                distance: Math.round(nearest.dMin * 100) / 100,
              },
            });
          } else {
            // Approach way-point: from the anchor toward that unit's nearest
            // living model, halting inside own reach short of the body (the
            // walls/AoO machinery resolves the actual walk).
            const tx = pool.x[nearest.idx] ?? 0;
            const ty = pool.y[nearest.idx] ?? 0;
            const dx = tx - anchor.x;
            const dy = ty - anchor.y;
            const dist = Math.hypot(dx, dy);
            if (dist === 0) continue;
            const stopShort = Math.max(cellFeet * 0.2, reachFt - 1);
            const walk = Math.max(0, dist - stopShort);
            orders.set(unit.id, {
              issuedBy: "doctrine",
              issuedTurn: strategicTurn,
              pending: [
                {
                  kind: "move",
                  path: [
                    {
                      x: anchor.x + (dx / dist) * walk,
                      y: anchor.y + (dy / dist) * walk,
                    },
                  ],
                  pace: "march",
                },
              ],
            });
            emit({
              subPhase: "move",
              type: "doctrine-advance",
              unitId: unit.id,
              targetUnitId: nearest.unit.id,
              at: { x: anchor.x, y: anchor.y },
              text: `${unit.name} advances on ${nearest.unit.name} (doctrine)`,
              data: {
                kind: "doctrine",
                action: "advance",
                distance: Math.round(walk * 100) / 100,
              },
            });
          }
        }
      }

      // ── G-04/D-223 — Combat_Resolver_5 B12 army initiative (world setting
      // `strategicArmyInitiative`). VERBATIM from the reference (marches its
      // `initiativeModifier + d20` wording straight into this tie path, as
      // D-220 required):
      //
      //     const r0 = d20(b) + cfg.armies[0].init,
      //           r1 = d20(b) + cfg.armies[1].init;
      //     // B12: RAW tiebreaker — highest initiative modifier acts first on a tie
      //     b.initOrder = r1 > r0 ? [1,0] : (r1 < r0 ? [0,1]
      //        : (cfg.armies[1].init > cfg.armies[0].init ? [1,0] : [0,1]));
      //
      // i.e. each army rolls **d20 + initiativeModifier**; equal totals compare
      // total modifiers; armies still tied act in stable roster order. The
      // reference rolls once at battle start and acts half-army-at-a-time; this
      // implementation keys the simultaneous damage-application order by the
      // same figures (documented D-223 deviation: the roll re-forks each turn
      // from the seeded turn PRNG instead of being stored on battle state, so
      // replays remain deterministic; casualties suppress the losing side's
      // returns exactly as the half-army walk does).
      let armyRank: Map<string, number> | null = null;
      if (
        (ctx.worldSettings as Record<string, unknown>)
          ?.strategicArmyInitiative === true
      ) {
        const mods = new Map<string, number>();
        for (const u of units) {
          if (!mods.has(u.armyId)) mods.set(u.armyId, u.armyInitiative ?? 0);
        }
        const rolls = [...mods.keys()].sort().map((id, k) => {
          const die = forkRng(rng, 0x1000 + k, 0x5c).d(20);
          const mod = mods.get(id) ?? 0;
          return { id, die, mod, total: die + mod };
        });
        rolls.sort(
          (a, b) =>
            b.total - a.total || b.mod - a.mod || a.id.localeCompare(b.id),
        );
        armyRank = new Map(rolls.map((r, rank) => [r.id, rank]));
        const nameOf = (id: string) =>
          ctx.armies.find((a) => a._id === id)?.name ?? id;
        emit({
          subPhase: "melee",
          type: "army-initiative",
          unitId: "",
          text: `Initiative: ${rolls.map((r) => `${nameOf(r.id)} ${r.total} (d20 ${r.die} + ${r.mod})`).join(" vs ")} → ${nameOf(rolls[0]?.id ?? "")} acts first.`,
          data: {
            kind: "army-initiative",
            rolls: rolls.map((r) => ({
              armyId: r.id,
              die: r.die,
              modifier: r.mod,
              total: r.total,
            })),
          },
        });
      }

      // Helper: effective initiative for a unit (leader actor or profile fallback)
      const effectiveInitiativeOf = (
        unit: UnitView,
      ): { mod: number; tie: number } => {
        const actorJson = ctx.leaderActors[unit.id] as unknown as
          { system?: Record<string, unknown> } | undefined;
        if (actorJson) {
          try {
            const derived = deriveFromDocuments({
              actor: actorJson as unknown as {
                system?: Record<string, unknown>;
              },
              effects: [],
            });
            const mod = derived.initiative;
            // tie die: deterministic d20 from forked RNG so ordering cannot alter dice
            const tieRng = forkRng(rng, unitIndex(unit), 0x5a);
            const tie = tieRng.d(20);
            return { mod, tie };
          } catch {
            // fall through to profile fallback
          }
        }
        const prof = profiles.byUnitId.get(unit.id);
        const mod = prof?.dexMod ?? 0;
        const tieRng = forkRng(rng, unitIndex(unit), 0x5a);
        const tie = tieRng.d(20);
        return { mod, tie };
      };

      // Threat at this scale: a model threatens the squares a melee attack of its reach can
      // enter (AoN 102, "you threaten all squares into which you can make a melee attack"),
      // read through the one `threatenedCells` both scales use — the same function the
      // tactical layer reaches through `combatState`, so "does leaving this square
      // provoke?" has a single answer per scale.
      const leaderModelIdx = (unitId: string): number => {
        const unit = units.find((u) => u.id === unitId);
        const [start, end] = unit?.modelRange ?? [0, 0];
        for (let i = start; i < end && i < pool.count; i++) {
          if (((pool.status[i] ?? 0) & ModelStatus.dead) === 0) return i;
        }
        return -1;
      };
      const threatenedByModel = (modelIdx: number): PF1eCell[] => {
        const unitIdx = pool.unitIdx[modelIdx] ?? 0;
        const size = sizeByUnitIdx[unitIdx];
        const origin = cellAt(
          pool.x[modelIdx] ?? 0,
          pool.y[modelIdx] ?? 0,
          cellFeet,
        );
        // Reach is carried in squares (D-180) and the footprint comes from the leader
        // actor's size — the M07 seam's own reading, never a second size table.
        return threatenedCells({
          footprint: footprintCells(origin, size),
          reachSquares: reachSquaresByUnitIdx[unitIdx] ?? 1,
        });
      };
      let interruptQueue = createInterruptQueue(strategicTurn, "turn");
      // M05 — the march's attacks of opportunity, hoisted out of the stepwise path so the
      // simultaneous path provokes too (it did not: a mode bug, not a design — the same
      // P06/D-184 rule must not be escapable by choosing a turn mode).
      //
      // `from`/`to` are the marching anchor's feet positions. In simultaneous mode the caller
      // passes the round's start-of-turn layout, which is the faithful reading: every march in
      // a simultaneous round begins where the round began, so that is where threat is judged
      // (D-173's snapshot rule, the same one cover and flanking use).
      const marchOpportunities = (input: {
        mover: UnitView;
        from: { x: number; y: number };
        to: { x: number; y: number };
        dx: number;
        dy: number;
        withdraw: boolean;
      }): void => {
        const { mover, from, to, dx, dy, withdraw } = input;
                // ── attacks of opportunity against the march (P06, D-184). The walk is taken from
                // the grid walk itself (`cellsAlongSegment`) rather than from the continuous
                // displacement, so the interrupted squares are *squares* and the phantom
                // "grazed" square of a diagonal never provokes. A withdraw (order kind
                // `retreat`, SRD: "You can move up to double your speed … The square you start
                // out in is not considered threatened by any opponent you can see") exempts the
                // start square and nothing else; the sim has no visibility model, so every
                // enemy is treated as seen and the exemption applies to all of them.
                  const walked = cellsAlongSegment(from, to, cellFeet);
                  const moverIdx = leaderModelIdx(mover.id);
                  const moverUnitIdx = pool.unitIdx[moverIdx] ?? 0;
                  if (moverIdx >= 0 && walked.length > 1) {
                    const reactors: Array<{
                      id: string;
                      name: string;
                      threatens: (cell: PF1eCell) => boolean;
                      modelIdx: number;
                    }> = [];
                    for (const other of units) {
                      if (other.id === mover.id) continue;
                      const otherLeader = leaderModelIdx(other.id);
                      if (otherLeader < 0) continue;
                      // Enemies only, on the same relation the flanking pass uses (M04/D-182): a
                      // different faction. An ally — and the mover's own unit — never reacts.
                      const otherUnitIdx = pool.unitIdx[otherLeader] ?? 0;
                      if (
                        (factionByUnitIdx[otherUnitIdx] ?? null) ===
                        (factionByUnitIdx[moverUnitIdx] ?? null)
                      ) {
                        continue;
                      }
                      // Threat is per model, but a unit moves as a formation: any living model of the
                      // unit can take the opportunity, so the unit threatens what its members threaten.
                      const otherStart = other.modelRange?.[0] ?? 0;
                      const otherEnd = other.modelRange?.[1] ?? 0;
                      let threatenedSet: Set<string> | null = null;
                      // The model that actually reacts: the first living member whose reach covers a
                      // square the march left (so the budget is spent on a model that could strike).
                      let threatModel: number | null = null;
                      for (let i = otherStart; i < otherEnd && i < pool.count; i++) {
                        if (((pool.status[i] ?? 0) & ModelStatus.dead) !== 0) continue;
                        const cells = threatenedByModel(i);
                        if (cells.length === 0) continue;
                        if (threatenedSet === null) threatenedSet = new Set<string>();
                        for (const c of cells) threatenedSet.add(`${c.col},${c.row}`);
                        if (threatModel === null) threatModel = i;
                      }
                      if (threatenedSet === null || threatModel === null) continue;
                      const set = threatenedSet;
                      reactors.push({
                        id: other.id,
                        name: other.name,
                        modelIdx: threatModel,
                        threatens: (cell) => set.has(`${cell.col},${cell.row}`),
                      });
                    }
                    const result = queueMovementAoOs(interruptQueue, {
                      turn: strategicTurn,
                      substep: "move",
                      moverId: mover.id,
                      actionId: `move:${strategicTurn}:${mover.id}`,
                      path: walked,
                      ...(withdraw ? { withdraw: true } : {}),
                      cellFeet,
                      reactors,
                    });
                    interruptQueue = result.queue;
                    // The opportunity interrupts the march: it resolves where the provoker stood,
                    // before the rest of the move is committed. Movement in the sim is a formation
                    // translation applied below, so the queue is drained before that write — which is
                    // what makes the ordering rule true here rather than merely asserted.
                    while (true) {
                      const popped = resolveNextInterrupt(interruptQueue, {
                        initiativeOf: (id) => -leaderModelIdx(id),
                      });
                      interruptQueue = popped.queue;
                      const interrupt = popped.interrupt;
                      if (interrupt === null) break;
                      const reactor = reactors.find(
                        (r) => r.id === interrupt.reactorId,
                      );
                      if (reactor === undefined) continue;
                      const provokerIdx = moverIdx;
                      const used = pool.sys["aooUsed"]?.[reactor.modelIdx] ?? 0;
                      const refusal = aooRefusal({
                        used,
                        budgetMax: pool.sys["aooMax"]?.[reactor.modelIdx] ?? 1,
                      });
                      if (refusal !== null) {
                        // Say why the reaction did not happen rather than dropping it silently: a
                        // spent budget and a legal opportunity look identical in the log otherwise.
                        emit({
                          subPhase: "move",
                          type: "opportunity-refused",
                          unitId: reactor.id,
                          targetUnitId: mover.id,
                          at: {
                            x: pool.x[provokerIdx] ?? 0,
                            y: pool.y[provokerIdx] ?? 0,
                          },
                          text: `${reactor.name} forgoes the attack of opportunity — ${refusal}`,
                          data: {
                            kind: "attack-of-opportunity",
                            reactorId: reactor.id,
                            reason: refusal,
                          },
                        });
                        continue;
                      }
                      // Spend first: the budget is per round and the opportunity is being taken now.
                      const column = pool.sys["aooUsed"];
                      if (column !== undefined) column[reactor.modelIdx] = used + 1;
                      const res = resolvePF1eAttacks({
                        pool,
                        attackers: [reactor.modelIdx],
                        defenders: [provokerIdx],
                        registry: profiles.registry,
                        rng: forkRng(rng, unitIndex(mover), 4),
                      });
                      const damage = res.metrics.netDamageDealt;
                      emit({
                        subPhase: "move",
                        type: "opportunity",
                        unitId: reactor.id,
                        targetUnitId: mover.id,
                        at: {
                          x: pool.x[provokerIdx] ?? 0,
                          y: pool.y[provokerIdx] ?? 0,
                        },
                        text: `${reactor.name} strikes ${mover.name} as it leaves the threatened square`,
                        data: {
                          kind: "attack-of-opportunity",
                          reactorId: reactor.id,
                          provokerId: mover.id,
                          feetMoved: Math.round(Math.hypot(dx, dy) * 100) / 100,
                          squaresLeft: result.squaresLeft.length,
                          // The square the opportunity happened in — where the provoker was
                          // attacked, not where this march ends (P06's ordering rule).
                          square: interrupt.trigger.left ?? null,
                          ...(res.metrics.hits > 0
                            ? {
                                hits: res.metrics.hits,
                                damage: Math.round(damage * 100) / 100,
                              }
                            : {}),
                        },
                      });
                    }
                  }

      };


      if (simultaneous) {
        // F02 — simultaneous movement: every unit computes its translation from
        // the starting layout, then all translations are applied together. No
        // unit sees another unit's movement this phase — walls still block per
        // D-174, but mover-vs-mover collision is not re-checked mid-phase.
        const startXs = new Float32Array(pool.x);
        const startYs = new Float32Array(pool.y);
        simultaneousStartXs = startXs;
        simultaneousStartYs = startYs;
        const pendingMoves: Array<{
          unit: UnitView;
          dx: number;
          dy: number;
          cx: number;
          cy: number;
          traveled: number;
          hitWall: boolean;
          terrainSquares: number;
          terrainExtra: number;
          paceLabel: string;
          verb: string;
        }> = [];
        for (const unit of units) {
          const queue = orders.get(unit.id);
          const order = queue?.active ?? queue?.pending[0];
          if (!order || (order.kind !== "move" && order.kind !== "retreat"))
            continue;
          const typeStats =
            PF1E_UNIT_TYPE_STATS[
              unit.type as keyof typeof PF1E_UNIT_TYPE_STATS
            ];
          const movePoints = typeStats?.move ?? 0;
          if (movePoints <= 0) continue;
          let anchorX: number | null = null;
          let anchorY: number | null = null;
          const [aStart, aEnd] = unit.modelRange ?? [0, 0];
          for (let i = aStart; i < aEnd && i < pool.count; i++) {
            if (((pool.status[i] ?? 0) & ModelStatus.dead) === 0) {
              anchorX = startXs[i] ?? 0;
              anchorY = startYs[i] ?? 0;
              break;
            }
          }
          if (anchorX === null || anchorY === null) continue;
          // M05 — the march is priced by `planPF1eStride`, the same pure movement module the
          // stepwise path uses: one pace legality (run/charge straight lines, charge's 10-ft
          // floor and its difficult-terrain bar) and one cost model (difficult squares double
          // what they cost to cross), so no rule is escapable by choosing a turn mode.
          const pace: PF1eStridePace =
            order.kind === "retreat" ? "withdraw" : order.pace;
          const stride = planPF1eStride({
            from: { x: anchorX, y: anchorY },
            path: order.kind === "retreat" ? [order.toward] : order.path,
            pace,
            movePoints,
            cellFeet,
            difficult: difficultCells,
            blockAt: (fx, fy, tx, ty) => firstMoveBlock(fx, fy, tx, ty, ctx.walls),
            blockEpsilon: MOVE_BLOCK_EPSILON,
          });
          if (stride.refusal !== null) {
            emit({
              subPhase: "move",
              type: "move-refused",
              unitId: unit.id,
              at: { x: anchorX, y: anchorY },
              text: `${unit.name} does not march — ${stride.refusal}`,
              data: { kind: "move", pace, refusal: stride.refusal },
            });
            continue;
          }
          const cx = stride.to.x;
          const cy = stride.to.y;
          const dx = cx - anchorX;
          const dy = cy - anchorY;
          const hitWall = stride.hitWall;
          const traveled = stride.traveled;
          if (dx === 0 && dy === 0 && !hitWall) continue;
          const paceLabel = order.kind === "retreat" ? "retreat" : order.pace;
          const verb =
            order.kind === "retreat"
              ? "retreats"
              : order.pace === "run"
                ? "runs"
                : order.pace === "charge"
                  ? "charges"
                  : "moves";
          if (pace === "charge") chargedUnits.add(unit.id);
          pendingMoves.push({
            unit,
            dx,
            dy,
            cx,
            cy,
            traveled,
            hitWall,
            terrainSquares: stride.terrainSquares,
            terrainExtra: stride.terrainExtra,
            paceLabel,
            verb,
          });
        }
        // M05 — a simultaneous round still provokes: every march starts from the layout at the
        // start of the round, so that is the layout the opportunity is judged against, and the
        // reactions resolve before any translation is applied (P06/D-184's ordering rule,
        // which the stepwise path already honoured — the asymmetry was a mode bug, not a design).
        for (const m of pendingMoves) {
          marchOpportunities({
            mover: m.unit,
            from: { x: m.cx - m.dx, y: m.cy - m.dy },
            to: { x: m.cx, y: m.cy },
            dx: m.dx,
            dy: m.dy,
            withdraw: m.paceLabel === "retreat",
          });
        }
        for (const m of pendingMoves) {
          const [start, end] = m.unit.modelRange ?? [0, 0];
          for (let i = start; i < end && i < pool.count; i++) {
            if (((pool.status[i] ?? 0) & ModelStatus.dead) !== 0) continue;
            pool.x[i] = (pool.x[i] ?? 0) + m.dx;
            pool.y[i] = (pool.y[i] ?? 0) + m.dy;
            const q = orders.get(m.unit.id);
            const o = q?.active ?? q?.pending[0];
            if (o?.kind === "move" && o.facing !== undefined)
              pool.rot[i] = o.facing;
          }
        }
        // Emit after translation so the log reads in initiative order later (events
        // themselves are emitted in initiative order for the report, but move events
        // have no initiative — they are emitted in unit array order, which is
        // deterministic and matches the report's subPhase ordering).
        for (const m of pendingMoves) {
          emit({
            subPhase: "move",
            type: "arrive",
            unitId: m.unit.id,
            at: { x: m.cx, y: m.cy },
            text: `${m.unit.name} ${m.verb} to (${m.cx.toFixed(1)}, ${m.cy.toFixed(1)})`,
            data: {
              pace: m.paceLabel,
              distance: Math.round(m.traveled * 100) / 100,
              anchorX: m.cx,
              anchorY: m.cy,
              ...(m.terrainSquares > 0
                ? {
                    terrainSquares: m.terrainSquares,
                    terrainExtraFeet: Math.round(m.terrainExtra * 100) / 100,
                  }
                : {}),
              ...(m.hitWall ? { blockedByWall: true } : {}),
            },
          });
        }
      } else {
        // ── move sub-phase (M05, D-173/D-175). A unit with a move or retreat order spends
        // its turn moving as a formation: the anchor (first living model) walks the ordered
        // waypoint path up to its movement budget, and every other living model is
        // translated by the same delta — the §12 reference package's model, which keeps
        // model spacing and unit membership intact. Dead models stay where they fell.
        // Budget = the unit type's move points × one grid cell (scene grid distance, per
        // P01's "use scene metadata, not constants") × the pace multiplier. SRD (R02,
        // CRB "Movement in Combat"/"Run"/"Charge"): a round's move covers your speed,
        // "up to double your speed" when charging, "up to four times your speed in a
        // straight line" when running (d20pfsrd Combat). Retreat is SRD Withdraw: "When
        // you withdraw, you can move up to double your speed" — the destination is the
        // order's rally point. Charge's attack requirements and Run's straight-line
        // restriction are combat-mechanic concerns of later M05 slices; this slice
        // executes only the distances. Terrain, obstacles and movement-triggered AoOs
        // likewise follow in later slices.
        for (const unit of units) {
          const queue = orders.get(unit.id);
          const order = queue?.active ?? queue?.pending[0];
          if (!order || (order.kind !== "move" && order.kind !== "retreat"))
            continue;
          const typeStats =
            PF1E_UNIT_TYPE_STATS[
              unit.type as keyof typeof PF1E_UNIT_TYPE_STATS
            ];
          const movePoints = typeStats?.move ?? 0;
          if (movePoints <= 0) continue;
          const anchor = anchorPosition(pool, unit);
          if (anchor === null) continue; // a unit with no living models cannot move

          // M05 — priced by `planPF1eStride`: the pace's straight-line and 10-ft rules, the
          // charge bar against difficult terrain, and the doubled cost of every rough square
          // entered, on top of D-174's wall clipping (which the stride applies first, so a
          // blocked march never gets to spend budget on a leg it cannot reach). The stride is
          // shared with the simultaneous path, so no movement rule depends on the turn mode.
          const pace: PF1eStridePace =
            order.kind === "retreat" ? "withdraw" : order.pace;
          const stride = planPF1eStride({
            from: { x: anchor.x, y: anchor.y },
            path: order.kind === "retreat" ? [order.toward] : order.path,
            pace,
            movePoints,
            cellFeet,
            difficult: difficultCells,
            blockAt: (fx, fy, tx, ty) =>
              firstMoveBlock(fx, fy, tx, ty, ctx.walls),
            blockEpsilon: MOVE_BLOCK_EPSILON,
          });
          if (stride.refusal !== null) {
            // The pace was illegal, so nobody moves — and the report says why, rather than a
            // queue that silently does nothing for a turn.
            emit({
              subPhase: "move",
              type: "move-refused",
              unitId: unit.id,
              at: { x: anchor.x, y: anchor.y },
              text: `${unit.name} does not march — ${stride.refusal}`,
              data: { kind: "move", pace, refusal: stride.refusal },
            });
            continue;
          }
          const cx = stride.to.x;
          const cy = stride.to.y;
          const startX = anchor.x;
          const startY = anchor.y;
          const dx = cx - startX;
          const dy = cy - startY;
          const hitWall = stride.hitWall;
          const traveled = stride.traveled;
          if (pace === "charge") chargedUnits.add(unit.id);
          // A wall-blocked unit reports even a zero-distance attempt, so the GM sees why
          // the march went nowhere; otherwise a no-op move stays silent.
          if (dx === 0 && dy === 0 && !hitWall) continue;

          marchOpportunities({
            mover: unit,
            from: { x: startX, y: startY },
            to: { x: cx, y: cy },
            dx,
            dy,
            withdraw: order.kind === "retreat",
          });

          // The march is committed after the reactions resolve (P06/D-184's ordering: the
          // opportunity happens in the square that was left, before the rest of the move).
          {
            const [start, end] = unit.modelRange ?? [0, 0];
            for (let i = start; i < end && i < pool.count; i++) {
              if (((pool.status[i] ?? 0) & ModelStatus.dead) !== 0) continue;
              pool.x[i] = (pool.x[i] ?? 0) + dx;
              pool.y[i] = (pool.y[i] ?? 0) + dy;
              if (order.kind === "move" && order.facing !== undefined)
                pool.rot[i] = order.facing;
            }
          }

          const paceLabel = order.kind === "retreat" ? "retreat" : order.pace;
          const verb =
            order.kind === "retreat"
              ? "retreats"
              : order.pace === "run"
                ? "runs"
                : order.pace === "charge"
                  ? "charges"
                  : "moves";
          emit({
            subPhase: "move",
            type: "arrive",
            unitId: unit.id,
            at: { x: cx, y: cy },
            text: `${unit.name} ${verb} to (${cx.toFixed(1)}, ${cy.toFixed(1)})`,
            data: {
              pace: paceLabel,
              distance: Math.round(traveled * 100) / 100,
              anchorX: cx,
              anchorY: cy,
              // Observable to the GM: what the ground cost. A march across rough squares
              // covers fewer feet for the same budget, and the report says so (M05).
              ...(stride.terrainSquares > 0
                ? {
                    terrainSquares: stride.terrainSquares,
                    terrainExtraFeet: Math.round(stride.terrainExtra * 100) / 100,
                  }
                : {}),
              // Observable to the GM: the march ended at a movement-blocking wall, not at
              // the path's end or the budget's limit.
              ...(hitWall ? { blockedByWall: true } : {}),
            },
          });
        }
      }

      // M05 — the charge's other half. CRB p.183: "you take a –2 penalty to your Armor Class
      // until your next turn." Written after the move phase and before anything this round can
      // strike back, so a charger is exposed to the enemies that did not yet resolve; the next
      // round's profile reseed rewrites the column, which is what makes "until your next turn"
      // true here without a timer (the same expiry mechanism D-178's cleave penalty relies on).
      if (chargedUnits.size > 0 && pool.sys["ac"]) {
        for (const unit of units) {
          if (!chargedUnits.has(unit.id)) continue;
          const [start, end] = unit.modelRange ?? [0, 0];
          for (let i = start; i < end && i < pool.count; i++) {
            if (((pool.status[i] ?? 0) & ModelStatus.dead) !== 0) continue;
            pool.sys["ac"][i] = (pool.sys["ac"][i] ?? 0) - 2;
          }
          emit({
            subPhase: "move",
            type: "charge-exposure",
            unitId: unit.id,
            text: `${unit.name} is flat of foot after the charge (−2 AC until its next turn)`,
            data: { kind: "charge", acPenalty: -2 },
          });
        }
      }

      grid.rebuild(pool);

      // ── heal sub-phase (M06, D-176). SRD Universal Monster Rules (R02): a creature
      // with fast healing "regains the listed number of Hit Points at the start of its
      // turn … can never exceed its maximum Hit Points", and regeneration heals "as
      // with fast healing". The start of a unit's turn is implemented as this
      // once-per-turn step, run immediately after seeding — the first moment the pool
      // carries interned profile indices — and before any damage this round resolves.
      // Only living models heal: fast healing "continues to function until a creature
      // dies". The healed total is booked into analytics' damageHealed (M11).
      for (const unit of units) {
        const profile = profiles.byUnitId.get(unit.id);
        if (
          !profile ||
          (profile.fastHealingVal <= 0 && profile.regenerationVal <= 0)
        )
          continue;
        const [start, end] = unit.modelRange ?? [0, 0];
        const living: number[] = [];
        for (let i = start; i < end && i < pool.count; i++) {
          if (((pool.status[i] ?? 0) & ModelStatus.dead) === 0) living.push(i);
        }
        if (living.length === 0) continue;
        const healRes = resolvePF1eHealing(pool, living, profiles.registry);
        if (healRes.totalHealed > 0) {
          analytics.recordHealing(unit.id, healRes.totalHealed);
          emit({
            subPhase: "heal",
            type: "heal",
            unitId: unit.id,
            text: `${unit.name} heals ${healRes.totalHealed} hit points (${profile.regenerationVal > 0 ? "regeneration" : "fast healing"})`,
            data: {
              healed: healRes.totalHealed,
              revived: healRes.revivedCount,
            },
          });
        }
      }

      // Leadership auras: once per hero unit, anchored on that unit's lead model.
      // "Hero" is a property of the unit (`type: "hero"` or `stats.hero`) or of the M07
      // data path (a leader actor bound to the unit), never a magic profile id — ids are
      // assigned by content, so the old `profileIdx === 4` test would have matched
      // whichever unit happened to intern fourth.
      for (const unit of units) {
        if (!isHeroUnit(unit, ctx.leaderActors)) continue;
        // M09 (D-230): the aura emanates from the leader's first LIVING model, so losing
        // the leader silences it in the same turn (the bridge also dead-guards). Radius
        // and bonus are authored unit stats, not hardcoded — worked-example values 30/+2
        // remain the default when the unit carries none.
        const anchor = anchorPosition(pool, unit);
        if (anchor === null) continue;
        const aura = applyHeroLeadershipAuras({
          pool,
          grid,
          heroModelIdx: anchor.idx,
          radius: unit.stats["leadershipRadius"] ?? 30,
          moraleBonus: unit.stats["leadershipMoraleBonus"] ?? 2,
        });
        // M05 — the `morale` sub-phase now has an executor and a line in the report. The
        // morale rule this project adopts is G §4.1's leadership clause and nothing else:
        // "Nearby friendly grunts receive morale bonuses to … Saving Throws", radiating from a
        // living leader. There is no break/rout check to implement, because the Core Rulebook
        // has no mass-combat morale check at all (that is Ultimate Combat's optional subsystem,
        // outside the R02 transcription scope) — so `stats.morale` and the reserved
        // `ModelStatus.routed` bit stay display-side metadata rather than a rule the report
        // implies is running. The attack and damage halves of the clause cannot ride this pool
        // at all: attack bonuses come from the compiled *profile*, shared by every model of the
        // type, so a per-aura attack term would need its own column (§19 budget decision) — the
        // saves columns exist, so the saves half is what is applied.
        if (aura.buffedModels.length > 0) {
          emit({
            subPhase: "morale",
            type: "leadership-aura",
            unitId: unit.id,
            at: { x: anchor.x, y: anchor.y },
            text: `${unit.name} leads from the front: +${unit.stats["leadershipMoraleBonus"] ?? 2} on Fortitude and Will for ${aura.buffedModels.length} model(s) within ${unit.stats["leadershipRadius"] ?? 30} ft`,
            data: {
              kind: "leadership-aura",
              radiusFeet: unit.stats["leadershipRadius"] ?? 30,
              moraleBonus: unit.stats["leadershipMoraleBonus"] ?? 2,
              buffedModels: aura.buffedModels.length,
            },
          });
        }
      }

      // ── G-04/D-223 — Combat_Resolver_5 envelopment wrap (Work Plan Task 4
      // step 3, restored in its D-130 lawful form). In the reference a wider
      // unit's excess files never idle opposite nothing: they wrap the enemy's
      // flanks — slots anchored on the defender's outermost living "corner"
      // model, stacking outward at formation spacing and stepping down the
      // enemy's side toward its rear (C10/C11/C12/C13), gated on actual
      // base-to-base engagement (C6) and on the per-unit envelop toggle (C2).
      // Grid-port, honouring D-130: NO invented +4/flat-footed rule — the wrap
      // only moves models, and whatever AoN 183 geometry it creates is judged
      // by the same `markPF1eFlanking` pass as everything else (+2 melee AB,
      // nothing more). A unit wraps only when engaged (some own model inside
      // the defender's reach-band), when its living frontage exceeds the
      // defender's by more than a square, and only for models standing beyond
      // the defender's frontage — the front rank stays put (C11). Slots step
      // down the enemy's flank at one square apiece on the model's own side
      // (C13: a file never crosses the centreline). The manoeuvre is declared
      // abstract (D-223): it resolves on contact as the turn's formation
      // action, distance-uncapped — the reference wraps these same models with
      // their per-model move after the formation's march, and our rigid
      // translation has no per-model remainder to spend.
      if (
        doctrineMode &&
        (ctx.worldSettings as Record<string, unknown>)?.strategicEnvelop !==
          false
      ) {
        for (let ui = 0; ui < units.length; ui++) {
          const unit = units[ui];
          if (!unit || unit.envelop === false) continue;
          const queue = orders.get(unit.id);
          const order = queue?.active ?? queue?.pending[0];
          if (order?.kind !== "attack" || !order.targetUnitId) continue;
          const target = units.find((u) => u.id === order.targetUnitId);
          if (!target) continue;
          const anchorA = anchorPosition(pool, unit);
          const anchorB = anchorPosition(pool, target);
          if (anchorA === null || anchorB === null) continue;
          const dirLen = Math.hypot(
            anchorB.x - anchorA.x,
            anchorB.y - anchorA.y,
          );
          if (dirLen === 0) continue;
          const ux = (anchorB.x - anchorA.x) / dirLen;
          const uy = (anchorB.y - anchorA.y) / dirLen;
          const px = -uy;
          const py = ux;
          const latOf = (i: number) =>
            (pool.x[i] ?? 0) * px + (pool.y[i] ?? 0) * py;
          const aliveOf = (u: UnitView, out: number[]): number[] => {
            const [s, e] = u.modelRange ?? [0, 0];
            for (let i = s; i < e && i < pool.count; i++) {
              if (((pool.status[i] ?? 0) & ModelStatus.dead) === 0) out.push(i);
            }
            return out;
          };
          const ownLiving = aliveOf(unit, []);
          const foeLiving = aliveOf(target, []);
          if (ownLiving.length === 0 || foeLiving.length === 0) continue;
          const reachFt = reachFeetByUnitIdx[ui] ?? cellFeet;
          // C6 gate: engaged = at least one own model inside the reach-band it
          // wrapped through (its own reach plus a square of give).
          let engaged = false;
          let dMinPair = Infinity;
          for (const a of ownLiving) {
            for (const b of foeLiving) {
              const d = Math.hypot(
                (pool.x[b] ?? 0) - (pool.x[a] ?? 0),
                (pool.y[b] ?? 0) - (pool.y[a] ?? 0),
              );
              if (d < dMinPair) dMinPair = d;
              if (d <= reachFt + cellFeet) {
                engaged = true;
                break;
              }
            }
            if (engaged) break;
          }
          if (!engaged) continue;
          let foeMin = Infinity;
          let foeMax = -Infinity;
          for (const b of foeLiving) {
            const l = latOf(b);
            if (l < foeMin) foeMin = l;
            if (l > foeMax) foeMax = l;
          }
          let ownMin = Infinity;
          let ownMax = -Infinity;
          for (const a of ownLiving) {
            const l = latOf(a);
            if (l < ownMin) ownMin = l;
            if (l > ownMax) ownMax = l;
          }
          if (!(ownMax - ownMin > foeMax - foeMin + cellFeet)) continue;
          let wrapped = 0;
          for (const side of [1, -1] as const) {
            // The defender's outermost living model on this side — the corner
            // the wrap is anchored on (the reference recomputes it every turn;
            // the wrap ratchets outward as corner models fall).
            let cornerIdx = -1;
            let cornerLat = -Infinity;
            for (const b of foeLiving) {
              const l = latOf(b) * side;
              if (l > cornerLat) {
                cornerLat = l;
                cornerIdx = b;
              }
            }
            if (cornerIdx < 0) continue;
            const foeEdge = side === 1 ? foeMax : foeMin;
            const excess = ownLiving
              .filter((a) => side * (latOf(a) - foeEdge) > cellFeet * 0.5)
              .sort((a, b) => side * (latOf(b) - latOf(a)) || a - b);
            const cx = pool.x[cornerIdx] ?? 0;
            const cy = pool.y[cornerIdx] ?? 0;
            for (let k = 0; k < excess.length; k++) {
              const m = excess[k];
              if (m === undefined) continue;
              // Slot k: at own reach beside the corner, stepped down the
              // enemy's side toward its rear by one square per wrap rank.
              pool.x[m] = cx + px * side * reachFt - ux * (k * cellFeet);
              pool.y[m] = cy + py * side * reachFt - uy * (k * cellFeet);
              wrapped++;
            }
          }
          if (wrapped > 0) {
            grid.rebuild(pool);
            emit({
              subPhase: "move",
              type: "envelop",
              unitId: unit.id,
              targetUnitId: target.id,
              at: { x: anchorA.x, y: anchorA.y },
              text: `${unit.name} wraps ${wrapped} model${wrapped === 1 ? "" : "s"} around ${target.name}'s flank (envelop)`,
              data: {
                kind: "envelop",
                wrapped,
                distance: Math.round(dMinPair * 100) / 100,
              },
            });
          }
        }
      }

      // ── flanking (M04, D-182). AoN 183's line test, not the old "≥2 attackers in
      // contact" heuristic: every living model's FLANKED bit is cleared and recomputed
      // once per turn from the layout, so a defender flanked by two enemies on opposite
      // borders — from any units, not just the one it is being attacked by this round —
      // carries the bit, and a stale bit can never survive a round in which the geometry
      // stopped supporting it. The melee sub-phase then reads the per-defender bit through
      // `resolvePF1eAttacks`, exactly as the tactical scale reads it. Runs after movement,
      // before any engagement resolves.
      // F02 — faithful simultaneous reading: flanking/cover computed from pre-move positions
      // for the whole phase (a unit that moves out of cover still benefits from cover for
      // shots exchanged that phase). Sequential keeps post-move geometry.
      // G-04/D-223 override: in doctrine mode the reference judges the CURRENT per-soldier
      // placement (there is no snapshot concept in combat_resolver_5), so the pass reads
      // post-wrap positions in both modes.
      if (
        simultaneous &&
        simultaneousStartXs &&
        simultaneousStartYs &&
        !doctrineMode
      ) {
        // Save post-move, swap to pre-move for the flanking pass, then restore
        const postXs = pool.x;
        const postYs = pool.y;
        (pool as unknown as { x: Float32Array; y: Float32Array }).x =
          simultaneousStartXs;
        (pool as unknown as { y: Float32Array }).y = simultaneousStartYs;
        grid.rebuild(pool);
        markPF1eFlanking({
          pool,
          grid,
          cellFeet,
          factionByUnitIdx,
          reachSquaresByUnitIdx,
          sizeByUnitIdx,
        });
        (pool as unknown as { x: Float32Array }).x = postXs;
        (pool as unknown as { y: Float32Array }).y = postYs;
        grid.rebuild(pool);
      } else {
        markPF1eFlanking({
          pool,
          grid,
          cellFeet,
          factionByUnitIdx,
          reachSquaresByUnitIdx,
          sizeByUnitIdx,
        });
      }

      // F02 — melee in simultaneous mode is initiative-ordered (damage order)
      // Every unit's attacks are rolled simultaneously (fork per unit) but applied
      // in descending effectiveInitiative so a higher-init unit's kills reduce the
      // lower-init's attack count. The 100-vs-100 archers at init 12 vs 7 is the
      // discriminating fixture: the 12-init unit fires with 100 models, the 7-init
      // with 80.
      // G-04/D-223 — with `strategicArmyInitiative` on, the army roll (B12:
      // d20 + initiativeModifier, modifier wins ties) becomes the primary key,
      // reproducing the reference's whole-army half: every unit of the winning
      // army resolves before the losing army's first return fire. Within an
      // army the per-unit effectiveInitiative still orders.
      const meleeUnits =
        simultaneous || armyRank !== null
          ? [...units]
              .map((u) => ({ unit: u, init: effectiveInitiativeOf(u) }))
              .filter(({ unit }) => {
                const q = orders.get(unit.id);
                const o = q?.active ?? q?.pending[0];
                return o?.kind === "attack" && !!o.targetUnitId;
              })
              .sort(
                (a, b) =>
                  (armyRank?.get(a.unit.armyId) ?? 0) -
                    (armyRank?.get(b.unit.armyId) ?? 0) ||
                  b.init.mod - a.init.mod ||
                  b.init.tie - a.init.tie,
              )
              .map(({ unit }) => unit)
              .concat(
                // Units without attack orders keep array order (they don't fight)
                [...units].filter((u) => {
                  const q = orders.get(u.id);
                  const o = q?.active ?? q?.pending[0];
                  return !(o?.kind === "attack" && !!o.targetUnitId);
                }),
              )
          : units;
      // M05 — `hold: defend` (CRB p.185 Defensive Combat). Applied after movement, so a
      // formation that marched into position and then braced is not also credited with the
      // brace for the march: at this scale one order is a unit's whole turn, and the brace is
      // the defensive half of standing fast. +2 dodge to AC is written on the models directly —
      // the same mechanism (and the same natural expiry) as the cleave and charge penalties:
      // the next round's profile reseed rewrites the column, so it never persists by accident.
      // The rule's other half, −4 on attacks, is inert here for the honest reason: a unit with
      // a hold order makes no attack this turn, and the module refuses nothing more than it
      // executes.
      const defendingUnits = new Set<string>();
      for (const unit of units) {
        const queue = orders.get(unit.id);
        const order = queue?.active ?? queue?.pending[0];
        if (!order || order.kind !== "hold" || order.stance !== "defend") continue;
        const [start, end] = unit.modelRange ?? [0, 0];
        let braced = 0;
        for (let i = start; i < end && i < pool.count; i++) {
          if (((pool.status[i] ?? 0) & ModelStatus.dead) !== 0) continue;
          if (pool.sys["ac"])
            pool.sys["ac"][i] = (pool.sys["ac"][i] ?? 0) + 2;
          braced++;
        }
        if (braced === 0) continue;
        defendingUnits.add(unit.id);
        emit({
          subPhase: "melee",
          type: "defend",
          unitId: unit.id,
          text: `${unit.name} fights defensively (+2 dodge AC this round)`,
          data: { kind: "defensive-combat", models: braced, acBonus: 2 },
        });
      }

      // Resolve Melee and Ranged Engagements (M05).
      //
      // One loop, two sub-phases: a unit whose compiled profile carries a ranged weapon shoots,
      // everything else swings. The routing matters because the *maths* differs — the profile's
      // attack routine for a ranged weapon is Dexterity-based, and `resolvePF1eAttacks` applies
      // the −2-per-increment range penalty and the weapon's maximum range only when it is told
      // the attack is ranged (§2.8/§2.9). Before this, an artillery order was resolved with melee
      // maths in the melee phase, which is why the declared `shoot` sub-phase had no executor.
      for (const unit of meleeUnits) {
        const queue = orders.get(unit.id);
        const order = queue?.active ?? queue?.pending[0];
        if (!order || order.kind !== "attack" || !order.targetUnitId) continue;

        const targetUnit = units.find((u) => u.id === order.targetUnitId);
        if (!targetUnit) continue;

        const targetUnitIdx = units.indexOf(targetUnit);
        const engageProfile = profiles.byUnitId.get(unit.id);
        const shoots =
          order.mode === "shot" ||
          (order.mode !== "melee" && (engageProfile?.isRanged ?? false));
        const engSubPhase = shoots ? "shoot" : "melee";

        // Collect attacker and defender model indices
        const [aStart, aEnd] = unit.modelRange ?? [0, 0];
        const [dStart, dEnd] = targetUnit.modelRange ?? [0, 0];

        const attackers: number[] = [];
        for (let i = aStart; i < aEnd && i < pool.count; i++) {
          if (((pool.status[i] ?? 0) & ModelStatus.dead) === 0)
            attackers.push(i);
        }

        const defenders: number[] = [];
        for (let i = dStart; i < dEnd && i < pool.count; i++) {
          if (((pool.status[i] ?? 0) & ModelStatus.dead) === 0)
            defenders.push(i);
        }

        // A shot beyond the weapon's maximum range is refused *here*, by name, instead of
        // resolving as zero attacks: the resolver declines those attacks silently (§2.9), and a
        // GM reading a report needs to know the artillery was simply too far away.
        if (shoots) {
          const inc = engageProfile?.rangeIncrement ?? 0;
          const maxInc = engageProfile?.maxIncrements ?? 0;
          const from = anchorPosition(pool, unit);
          const to = anchorPosition(pool, targetUnit);
          if (from !== null && to !== null && inc > 0 && maxInc > 0) {
            const distance = Math.hypot(to.x - from.x, to.y - from.y);
            const increments = Math.ceil(distance / inc);
            if (increments > maxInc) {
              emit({
                subPhase: "shoot",
                type: "shot-refused",
                unitId: unit.id,
                targetUnitId: targetUnit.id,
                at: { x: from.x, y: from.y },
                text: `${unit.name} cannot shoot ${targetUnit.name}: ${Math.round(distance)} ft is ${increments} range increments, beyond the weapon's maximum of ${maxInc}`,
                data: {
                  kind: "shot-refused",
                  distanceFeet: Math.round(distance * 100) / 100,
                  rangeIncrement: inc,
                  increments,
                  maxIncrements: maxInc,
                },
              });
              continue;
            }
          }
        }

        // Resolve PF1e Attack Loop. Dice come from the turn PRNG forked per unit
        // (§5A), never Math.random() — a seeded turn must replay identically.
        const combatRes = resolvePF1eAttacks({
          pool,
          attackers,
          defenders,
          registry,
          rng: forkRng(rng, unitIndex(unit), 1),
          isRanged: shoots,
          // The charge's +2 (CRB p.183) rides the routine it was declared for. A unit that
          // both charged and braced cannot exist: charging is a move, bracing is a hold, and a
          // unit has one order per turn — so the two modifiers never stack.
          ...(chargedUnits.has(unit.id) ? { circumstanceMod: 2 } : {}),
        });

        // Hero Cleave (D-178). Once per hero *unit* per engagement, SRD Cleave grants
        // "one extra melee attack at your full attack bonus against a foe adjacent to
        // you" (Gap List §5). It resolves as a real attack by the hero's lead model
        // against the first adjacent living defender — never the old overkill cascade,
        // which force-killed `defenders[0]` and splashed a literal 25 damage (the
        // rejected model, D-130). `maxIterativeAttacks: 1` keeps it to exactly one
        // attack regardless of the hero's iterative routine. Until actor feat data
        // exists, cleave rides the same `isHeroUnit` gate as the leadership aura.
        //
        // M10: the cleave is *reported*, not just folded. Its own metrics ride a
        // `hero-cleave` event before the engagement line, so the TurnReport timeline and
        // the Reports tab's type filter show that the extra swing happened and against
        // which model — the merged numbers stay in the engagement total exactly as D-178
        // booked them (one event per swing, one total per engagement, never double-counted).
        let cleaveReport: {
          metrics: Record<string, number>;
          heroIdx: number;
          defenderIdx: number;
        } | null = null;
        if (
          !shoots &&
          isHeroUnit(unit, ctx.leaderActors) &&
          attackers.length > 0
        ) {
          const heroIdx = attackers[0];
          if (heroIdx !== undefined) {
            const adjacentEnemy = grid
              .queryPoint(
                pool.x[heroIdx] ?? 0,
                pool.y[heroIdx] ?? 0,
                cellFeet,
                pool,
              )
              .find((n) => pool.unitIdx[n.index] === targetUnitIdx)?.index;
            if (adjacentEnemy !== undefined) {
              const cleaveRes = resolvePF1eAttacks({
                pool,
                attackers: [heroIdx],
                defenders: [adjacentEnemy],
                registry,
                rng: forkRng(rng, unitIndex(unit), 3),
                maxIterativeAttacks: 1,
              });
              const merged = combatRes.metrics as unknown as Record<
                string,
                number
              >;
              for (const [key, value] of Object.entries(cleaveRes.metrics)) {
                merged[key] = (merged[key] ?? 0) + (value as number);
              }
              cleaveReport = {
                metrics: { ...cleaveRes.metrics } as unknown as Record<
                  string,
                  number
                >,
                heroIdx,
                defenderIdx: adjacentEnemy,
              };
              // SRD Cleave penalty (R03/D-130): "You take a −2 penalty to your Armor
              // Class until your next turn." Seeding rewrites the ac column from the
              // profile every round before melee, so the penalty is naturally wiped at
              // the start of the hero's next round — meanwhile enemy units resolved
              // later THIS round attack against the reduced AC.
              if (pool.sys["ac"])
                pool.sys["ac"][heroIdx] = (pool.sys["ac"][heroIdx] ?? 0) - 2;
            }
          }
        }

        analytics.recordCombat(unit.id, combatRes.metrics);

        if (cleaveReport !== null) {
          emit({
            subPhase: engSubPhase,
            type: "hero-cleave",
            unitId: unit.id,
            targetUnitId: targetUnit.id,
            at: {
              x: pool.x[cleaveReport.heroIdx] ?? 0,
              y: pool.y[cleaveReport.heroIdx] ?? 0,
            },
            text: `${unit.name} cleaves to an adjacent foe: ${cleaveReport.metrics.hits} hits, ${cleaveReport.metrics.netDamageDealt} damage, ${cleaveReport.metrics.killsCount} kills (−2 AC until the next round)`,
            data: {
              kind: "cleave",
              heroModelIdx: cleaveReport.heroIdx,
              defenderModelIdx: cleaveReport.defenderIdx,
              ...cleaveReport.metrics,
            },
          });
        }

        emit({
          subPhase: engSubPhase,
          type: shoots ? "shot" : "attack",
          unitId: unit.id,
          targetUnitId: targetUnit.id,
          text: `${unit.name} ${shoots ? "shoots" : "attacks"} ${targetUnit.name}: ${combatRes.metrics.hits} hits, ${combatRes.metrics.netDamageDealt} damage, ${combatRes.metrics.killsCount} kills`,
          data: combatRes.metrics as unknown as Record<
            string,
            import("../core/documents").Json
          >,
        });
      }

      // Resolve AOE Spells (C05). Every input is order- or profile-driven: the order names
      // the point of origin; the casting unit's profile supplies the caster level and the
      // DC's key-ability modifier; the pack's `massBattle` block supplies shape, radius,
      // range category, saves and dice (DEVIATIONS D-2). Each refusal is named rather than
      // silently skipped, so a GM sees why a cast did not happen.
      for (const unit of units) {
        const queue = orders.get(unit.id);
        const order = queue?.active ?? queue?.pending[0];
        if (!order || order.kind !== "custom" || order.type !== "spell_aoe")
          continue;

        const refusal = (kind: string, reason: string): void => {
          emit({
            subPhase: "spell",
            type: "spellRefused",
            unitId: unit.id,
            text: `${unit.name} cannot cast: ${reason}`,
            data: { refusal: kind, reason },
          });
        };

        // 0. Spell selection (D-171): the order names the pack entry it casts in
        // `data.spell`; no name means the default spell. Unknown ids are refused by name.
        const spellId = payloadSpellId(order.data);
        const spellDef = spells[spellId];
        if (!spellDef) {
          refusal(
            "unknown_spell",
            `spell "${spellId}" is not in the mass-battle spell registry`,
          );
          continue;
        }

        // 1. Location is order-driven: the payload carries the point of origin (circle)
        // or the aim direction (cone/line — those shoot away from the caster, CRB p.214).
        // The shape is the selected spell's, probed once at creation.
        const payload = parseSpellAoePayload(
          spellShapes.get(spellId) ?? "circle",
          order.data,
        );
        if (!payload.ok) {
          refusal("bad_order", payload.message);
          continue;
        }

        // 2. Caster inputs are profile-driven. Missing stats fall back to the compiled
        // profile defaults (CL 1, key modifier +3) in `compilePF1eProfile`, never to a
        // constant at the call site.
        const profile = profiles.byUnitId.get(unit.id);
        if (!profile) {
          refusal(
            "no_caster_profile",
            "the casting unit has no compiled profile",
          );
          continue;
        }
        // 2b. M07: a leader actor bound to the unit outranks the unit-stats profile —
        // its authored caster level and key ability are the caster's real ones.
        const heroInputs = casterInputsFromLeaderActor(
          ctx.leaderActors[unit.id],
        );
        const casterLevel = heroInputs?.casterLevel ?? profile.casterLevel;
        const keyAbilityMod =
          heroInputs?.keyAbilityMod ?? profile.castingStatMod;
        const spellPenetration =
          heroInputs?.spellPenetration ?? profile.spellPenetration;

        // 3. Range is measured from the casting unit's anchor (first living model): a
        // spell's range is "the maximum distance at which you can designate the spell's
        // point of origin" (CRB p.213). A unit with no living models cannot cast at all.
        const anchor = anchorPosition(pool, unit);
        if (anchor === null) {
          refusal("no_living_caster", "the casting unit has no living models");
          continue;
        }

        // A caster who fails the defensive-cast check provokes — so the spell resolver
        // needs to know who threatens the anchor. Each enemy threatens at **its own**
        // natural reach, never at the caster's and never at a constant: "You threaten all
        // squares into which you can make a melee attack" (AoN Rules ID 102), and a Large
        // or larger creature has "a natural reach of 10 feet or more" (AoN 179). So the
        // query runs at the widest reach any unit present has and then keeps only the
        // models whose own unit reach covers the distance. Coordinates are feet; only
        // living models of other units can threaten (queryPoint skips dead/hidden).
        const casterAdjacentEnemies: number[] = [];
        const widestReachFt = reachFeetByUnitIdx.reduce(
          (m, r) => Math.max(m, r),
          cellFeet,
        );
        for (const n of grid.queryPoint(
          anchor.x,
          anchor.y,
          widestReachFt,
          pool,
        )) {
          const idx = n.index;
          const threatUnitIdx = pool.unitIdx[idx];
          if (threatUnitIdx === pool.unitIdx[anchor.idx]) continue;
          const threatReachFt =
            threatUnitIdx === undefined
              ? cellFeet
              : (reachFeetByUnitIdx[threatUnitIdx] ?? cellFeet);
          if (Math.sqrt(n.dist2) > threatReachFt) continue;
          casterAdjacentEnemies.push(idx);
        }

        // 4. The pack payload is built at the caster's actual level — "1d6 per caster
        // level (maximum 10d6)" resolves against it — from the selected spell's entry.
        const packSpell = parsePackSpellOrder({
          entry: spellDef.entry,
          casterLevel,
        });
        if (!packSpell.ok || packSpell.order === null) {
          refusal(
            "pack_issue",
            packSpell.issues.map((i) => i.message).join("; "),
          );
          continue;
        }

        // Cone/line shapes start at the caster; only the circle designates a remote
        // point, so only it is checked against the range category and the designation
        // line of effect (CRB pp.213–214).
        const origin =
          packSpell.order.shape === "circle"
            ? { x: payload.x, y: payload.y }
            : { x: anchor.x, y: anchor.y };
        const rangeFeet =
          packSpell.order.rangeCategory !== null
            ? spellRangeFeet(packSpell.order.rangeCategory, casterLevel)
            : null;
        if (packSpell.order.shape === "circle") {
          if (rangeFeet === null) {
            refusal(
              "pack_issue",
              `${packSpell.order.spellName}: circle shape without a range category`,
            );
            continue;
          }
          const distFeet = Math.hypot(origin.x - anchor.x, origin.y - anchor.y);
          if (distFeet > rangeFeet) {
            refusal(
              "out_of_range",
              `${packSpell.order.spellName}: the point of origin at ${Math.round(distFeet)} ft is beyond the ${packSpell.order.rangeCategory} range of ${rangeFeet} ft at caster level ${casterLevel}`,
            );
            continue;
          }

          // 4b. "You must have a clear line of effect to the point of origin of any
          // spell you cast" (CRB p.214). A sight-blocking wall between the caster and
          // the designated point refuses the cast outright.
          if (
            !hasLineOfEffect(anchor.x, anchor.y, origin.x, origin.y, ctx.walls)
          ) {
            refusal(
              "no_line_of_effect",
              `${packSpell.order.spellName}: no line of effect from the caster to the point of origin at (${origin.x}, ${origin.y})`,
            );
            continue;
          }
        }

        // 5. DC from the same formula the tactical engine uses, with the caster's own
        // key-ability modifier and the selected spell's verified level.
        const { dc: packDc, issues: dcIssues } = spellSaveDc({
          spellLevel: spellDef.level,
          keyAbilityMod,
        });
        if (dcIssues.length > 0) {
          refusal("pack_issue", dcIssues.map((i) => i.message).join("; "));
          continue;
        }

        const spellRes = resolvePF1eAOESpell({
          pool,
          grid,
          registry,
          spell: {
            spellName: packSpell.order.spellName,
            shape: packSpell.order.shape,
            x: origin.x,
            y: origin.y,
            radius: packSpell.order.radius,
            dirX: payload.dirX,
            dirY: payload.dirY,
            ...(packSpell.order.widthFeet !== null
              ? { widthFeet: packSpell.order.widthFeet }
              : {}),
            dc: packDc,
            spellLevel: spellDef.level,
            damageDiceCount: packSpell.order.damageDiceCount,
            damageDiceSides: packSpell.order.damageDiceSides,
            saveType: packSpell.order.saveType,
            halfOnSave: packSpell.order.halfOnSave,
            evasion: packSpell.order.evasionApplies,
            casterLevel,
            castingStatMod: keyAbilityMod,
            spellPenetration,
            // M11: failed defensive casting provokes these enemies at the caster model.
            casterIdx: anchor.idx,
          },
          casterAdjacentEnemies,
          rng: forkRng(rng, unitIndex(unit), 2),
          walls: ctx.walls,
          srRoundCache,
        });

        analytics.recordSpell(unit.id, spellRes.metrics);

        // Hit attribution (M11): the area affects models of ANY unit inside it (friendly
        // fire is rules-correct for an Area spell), so the outcome is booked per owning
        // unit — the event carries the breakdown, and `deathsCount` finally lands on the
        // unit that lost models rather than on the caster.
        const hitsByUnit = new Map<
          string,
          { modelsHit: number; damageDealt: number; kills: number }
        >();
        for (const outcome of spellRes.perModel) {
          const owner = units.find((u) => {
            const [start, end] = u.modelRange ?? [0, 0];
            return (
              outcome.idx >= start &&
              outcome.idx < end &&
              outcome.idx < pool.count
            );
          });
          if (!owner) continue;
          const bucket = hitsByUnit.get(owner.id) ?? {
            modelsHit: 0,
            damageDealt: 0,
            kills: 0,
          };
          bucket.modelsHit += 1;
          bucket.damageDealt += outcome.damageDealt;
          bucket.kills += outcome.killed ? 1 : 0;
          hitsByUnit.set(owner.id, bucket);
          if (outcome.killed) analytics.recordSpellKills(owner.id, 1);
        }

        const aimText =
          packSpell.order.shape === "circle"
            ? `at (${origin.x}, ${origin.y})`
            : `${packSpell.order.shape} aimed (${payload.dirX}, ${payload.dirY}) from (${origin.x}, ${origin.y})`;
        emit({
          subPhase: "spell",
          type: "spell",
          unitId: unit.id,
          text: `${unit.name} casts ${packSpell.order.spellName} ${aimText} (${packSpell.order.radius} ft, DC ${packDc}): ${spellRes.metrics.damageDealt} damage, ${spellRes.metrics.killsCount} kills`,
          // The cast parameters are part of the event, not just the outcome: they are what
          // makes "this order came from the pack and the profile" observable to a GM and
          // to a test.
          data: {
            ...(spellRes.metrics as unknown as Record<
              string,
              import("../core/documents").Json
            >),
            spellName: packSpell.order.spellName,
            spellId,
            spellRadius: packSpell.order.radius,
            spellDc: packDc,
            spellLevel: spellDef.level,
            casterLevel,
            spellDice: `${packSpell.order.damageDiceCount}d${packSpell.order.damageDiceSides}`,
            spellShape: packSpell.order.shape,
            epicenterX: origin.x,
            epicenterY: origin.y,
            rangeCategory: packSpell.order.rangeCategory,
            rangeFeet,
            // Per-unit breakdown: { modelsHit, damageDealt, kills } for every unit whose
            // models were in the area, caster included.
            hitsByUnit: Object.fromEntries(
              hitsByUnit,
            ) as unknown as import("../core/documents").Json,
          },
        });
      }
    },

    tick(ctx, pool, units, orders, rng, emit, dtSeconds): void {
      void ctx;
      void pool;
      void units;
      void orders;
      void rng;
      void emit;
      void dtSeconds;
    },

    detection(ctx, unit): number {
      void ctx;
      void unit;
      return 6;
    },

    forecast(_ctx, army) {
      void _ctx;
      // The collector lives as long as this module instance (all turns this worker has
      // resolved), so the forecast reports accumulated campaign totals for this army's
      // units — a SimWorker restart begins fresh accumulation (M11).
      const report = analytics.generateReport();
      const armyUnitIds = new Set(army.units.map((u) => u.id));
      const armyUnits = Object.values(report.units).filter((u) =>
        armyUnitIds.has(u.unitId),
      );
      const sum = (pick: (u: UnitAnalyticsSummary) => number): number =>
        armyUnits.reduce((acc, u) => acc + pick(u), 0);
      const totalAttacks = sum((u) => u.totalAttacks);
      const killsCount = sum((u) => u.killsCount);
      const netDamageDealt = sum((u) => u.netDamageDealt);
      const deathsCount = sum((u) => u.deathsCount);
      const rows = armyUnits
        .map((u) => ({
          label: `${u.unitId}: net damage`,
          value: u.netDamageDealt,
        }))
        .sort((a, b) => b.value - a.value);
      return {
        summary: `PF1e Army ${army.name}: ${totalAttacks} attacks, ${killsCount} kills, ${netDamageDealt} net damage${deathsCount > 0 ? `, ${deathsCount} models lost` : ""}`,
        rows,
        data: {
          totalAttacks,
          hits: sum((u) => u.hits),
          hitPercentage:
            totalAttacks > 0
              ? Math.round((sum((u) => u.hits) / totalAttacks) * 100)
              : 0,
          netDamageDealt,
          killsCount,
          deathsCount,
          savesPassed: sum((u) => u.savesPassed),
          savesFailed: sum((u) => u.savesFailed),
          aooExecuted: sum((u) => u.aooExecuted),
          aooHits: sum((u) => u.aooHits),
          concentrationPassed: sum((u) => u.concentrationPassed),
          concentrationFailed: sum((u) => u.concentrationFailed),
          srBlocked: sum((u) => u.srBlocked),
          // M14 (D-224): the full per-unit sheet rides the same payload, so the
          // Battle Analysis tab (normal navigation, not just e2eHook) rebuilds the
          // exact PF1eBattleReport the worker's collector holds — figures the
          // table and the RFC-4180 CSV both read.
          units: Object.fromEntries(
            armyUnits.map((u) => [u.unitId, { ...u }]),
          ) as unknown as import("../core/documents").Json,
        },
      };
    },
  };

  return module;
}

/**
 * Stable small integer per unit for `PRNG.fork()` sub-streams — same FNV-1a construction as
 * the reference package, so unit processing order cannot alter a unit's own outcomes (§5A).
 */
function unitIndex(unit: UnitView): number {
  let h = 2166136261;
  for (const ch of unit.id) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  return h & 0xffff;
}

/** Fork a sub-stream per (unit, phase) so the melee and spell loops stay independent. */
/**
 * Every living model a unit currently covers, by pool index — the index list the
 * per-turn AoO reset takes. Dead models are skipped: they take no opportunities, and
 * excluding them keeps the reset's own write count proportional to the living army.
 */
function livingModelIndices(
  pool: ModelPool,
  units: readonly UnitView[],
): number[] {
  const out: number[] = [];
  for (const unit of units) {
    const [start, end] = unit.modelRange ?? [0, 0];
    for (let i = start; i < end && i < pool.count; i++) {
      if (((pool.status[i] ?? 0) & ModelStatus.dead) === 0) out.push(i);
    }
  }
  return out;
}

function forkRng(rng: PRNG, unitHash: number, phase: number): PF1eRng {
  return pf1eRngFromPrng(rng.fork(((unitHash << 4) | phase) >>> 0));
}

/**
 * A unit led by a player hero (Leadership aura, Cleave). Identity rides the unit
 * (`type: "hero"` or `stats.hero`) OR the M07 data path: a leader token bound to an
 * actor — which `collectLeaderActors` has already resolved into `ctx.leaderActors`
 * (keyed by unit id). Not a magic profile id: ids are assigned by content.
 */
function isHeroUnit(
  unit: UnitView,
  leaderActors: Readonly<Record<string, unknown>>,
): boolean {
  return (
    unit.type === "hero" || unit.stats["hero"] === 1 || unit.id in leaderActors
  );
}

type SpellAoePayload =
  | { ok: true; x: number; y: number; dirX: number; dirY: number }
  | { ok: false; message: string };

const finiteNum = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);

/**
 * The `spell_aoe` order's `data`, per shape (CRB p.214):
 * - circle: `{ x, y }` — the designated point of origin, finite feet coordinates.
 * - cone/line: `{ dirX, dirY }` — the direction the spell shoots away from the caster;
 *   both finite, not both zero. Cones and lines start at the caster, so they take no
 *   point of origin.
 * Anything else is a named error rather than a silent fallback.
 */
function parseSpellAoePayload(shape: string, data: unknown): SpellAoePayload {
  const rec =
    typeof data === "object" && data !== null && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : null;
  if (rec === null) {
    return {
      ok: false,
      message:
        "order data must be an object like { x: 10, y: 10 } (circle) or { dirX: 1, dirY: 0 } (cone/line)",
    };
  }
  if (shape === "cone" || shape === "line") {
    if (
      !finiteNum(rec.dirX) ||
      !finiteNum(rec.dirY) ||
      (rec.dirX === 0 && rec.dirY === 0)
    ) {
      return {
        ok: false,
        message: `order data needs finite, non-zero dirX and dirY — the direction the ${shape} shoots`,
      };
    }
    return { ok: true, x: 0, y: 0, dirX: rec.dirX, dirY: rec.dirY };
  }
  if (!finiteNum(rec.x) || !finiteNum(rec.y)) {
    return {
      ok: false,
      message:
        "order data needs finite numeric x and y (the point of origin, in feet)",
    };
  }
  return { ok: true, x: rec.x, y: rec.y, dirX: 0, dirY: 0 };
}

/**
 * P02 seam — a unit's natural reach in **squares**, read from its bound leader actor
 * (`RulesContext.leaderActors`, keyed by unit id, resolved by `collectLeaderActors`).
 * Table 8-4's reach column is a per-size figure (AoN Rules ID 179), and the leader
 * actor's authored `system.pf1e.size` is the only unambiguous size the strategic scale
 * has: a unit profile's `sizeMod` cannot be inverted, because the recorded strategic
 * deviation lets one authored number serve both A.4 ladders — `+1` reads as Small on the
 * attack/AC ladder and as Large on the CMB/CMD one.
 *
 * Returns null when the document is missing or unparseable, and the caller keeps the
 * one-square Medium default D-177 established — a guessed size would silently change
 * who can engage whom. Body shape (Table 8-4's long column) is not read here: nothing
 * authors it at this scale yet, so the table's tall figure stands.
 */
export function reachSquaresFromLeaderActor(actorJson: unknown): number | null {
  const doc =
    typeof actorJson === "object" &&
    actorJson !== null &&
    !Array.isArray(actorJson)
      ? (actorJson as Record<string, unknown>)
      : null;
  if (doc === null) return null;
  const system =
    typeof doc.system === "object" &&
    doc.system !== null &&
    !Array.isArray(doc.system)
      ? (doc.system as Record<string, unknown>)
      : null;
  if (system === null) return null;
  const derived = deriveFromDocuments({ actor: { system } });
  return naturalReachSquares(derived.size);
}

/**
 * The same seam's size half (D-182): Table 8-4's sub-square "can't flank" exclusion
 * needs the authored size itself, not just its reach column. Returns null for a missing
 * or unparseable document, and `canFlank` then treats the model as the Medium default —
 * the same direction `reachSquaresFromLeaderActor` takes, so a unit without actor data
 * is never excluded from a rule on the strength of absent data.
 */
export function sizeFromLeaderActor(actorJson: unknown): string | null {
  const doc =
    typeof actorJson === "object" &&
    actorJson !== null &&
    !Array.isArray(actorJson)
      ? (actorJson as Record<string, unknown>)
      : null;
  if (doc === null) return null;
  const system =
    typeof doc.system === "object" &&
    doc.system !== null &&
    !Array.isArray(doc.system)
      ? (doc.system as Record<string, unknown>)
      : null;
  if (system === null) return null;
  const derived = deriveFromDocuments({ actor: { system } });
  return derived.size ?? null;
}

/**
 * M07 seam — caster inputs from a leader actor document (RulesContext.leaderActors is
 * keyed by unit id). Runs the same tactical derivation the cast flow uses, so a hero's
 * authored caster level, key ability and Spell Penetration reach the strategic battle.
 * Returns null — and the caller keeps the unit-stats profile — when the document is
 * missing, unparseable, or the actor is not a caster (`spellCasterLevel` 0).
 */
/**
 * M07 — tactical authored stats that the strategic unit profile consumes. Authoritative
 * attack/defense inputs for a hero-led unit, derived from the leader's ActorDocument with
 * the same `deriveFromDocuments` the tabletop engine uses (G §4.12: the hero drives the
 * strategic profile through tactical numbers).
 */
export interface LeaderActorStatOverlay {
  /** `attributes.hp.max`. */
  hp: number;
  /** `attributes.speed.base.total` × 5 ft-per-square conversion at the deploy grain. */
  move: number;
  touchAc: number;
  drVal: number;
  sr: number;
  fort: number;
  ref: number;
  will: number;
  bab: number;
  strMod: number;
  dexMod: number;
}

/**
 * M07 (D-229) — read every strategic-consumed authored stat from the leader's actor
 * document. The mapping is one tactical derivation call; numeric keys match
 * `rawProfileFromUnit`, so a merged `unit.stats` update feeds deploy-seed and profile
 * reload with no further plumbing. Returns null (caller keeps the unit's authored stats)
 * when the document is missing or unparseable.
 */
export function combatStatsFromLeaderActor(
  actorJson: unknown,
): LeaderActorStatOverlay | null {
  const doc =
    typeof actorJson === "object" &&
    actorJson !== null &&
    !Array.isArray(actorJson)
      ? (actorJson as Record<string, unknown>)
      : null;
  if (doc === null) return null;
  const system =
    typeof doc.system === "object" &&
    doc.system !== null &&
    !Array.isArray(doc.system)
      ? (doc.system as Record<string, unknown>)
      : null;
  if (system === null) return null;
  const derived = deriveFromDocuments({ actor: { system } });
  return {
    hp: derived.hpMax,
    move: derived.speedFt,
    touchAc: derived.ac.touch,
    drVal: derived.dr,
    sr: derived.spellResistance,
    fort: derived.saves.fort,
    ref: derived.saves.ref,
    will: derived.saves.will,
    bab: derived.baseAttack,
    strMod: derived.abilityMods.str,
    dexMod: derived.abilityMods.dex,
  };
}

/**
 * Numeric keys written by `combatStatsFromLeaderActor` — the write-back complement used
 * to persist hero-authored stats into the Unit document inside the resolve envelope.
 */
export const LEADER_STAT_OVERLAY_KEYS: ReadonlyArray<
  keyof LeaderActorStatOverlay
> = [
  "hp",
  "move",
  "touchAc",
  "drVal",
  "sr",
  "fort",
  "ref",
  "will",
  "bab",
  "strMod",
  "dexMod",
];

export function casterInputsFromLeaderActor(actorJson: unknown): {
  casterLevel: number;
  keyAbilityMod: number;
  spellPenetration: number;
} | null {
  const doc =
    typeof actorJson === "object" &&
    actorJson !== null &&
    !Array.isArray(actorJson)
      ? (actorJson as Record<string, unknown>)
      : null;
  if (doc === null) return null;
  const system =
    typeof doc.system === "object" &&
    doc.system !== null &&
    !Array.isArray(doc.system)
      ? (doc.system as Record<string, unknown>)
      : null;
  if (system === null) return null;
  const derived = deriveFromDocuments({ actor: { system } });
  if (derived.spellCasterLevel <= 0) return null;
  const parsed = parsePF1eActorSystem(system.pf1e);
  return {
    casterLevel: derived.spellCasterLevel,
    keyAbilityMod: derived.abilityMods[derived.spellKeyAbility],
    spellPenetration: parsed.ok ? (parsed.value.spellPenetration ?? 0) : 0,
  };
}

/**
 * Index + position (feet) of the unit's first living model, or null when none are alive.
 * The index matters for M11: it is the caster a threatened enemy swings at (defensive
 * casting AoO), not just the point range is measured from.
 */
function anchorPosition(
  pool: ModelPool,
  unit: UnitView,
): { idx: number; x: number; y: number } | null {
  const [start, end] = unit.modelRange ?? [0, 0];
  for (let i = start; i < end && i < pool.count; i++) {
    if (((pool.status[i] ?? 0) & ModelStatus.dead) === 0) {
      return { idx: i, x: pool.x[i] ?? 0, y: pool.y[i] ?? 0 };
    }
  }
  return null;
}
