/**
 * Pathfinder 1e Mass Battles Reference System ("pf1e-mass-battles").
 * Integrates d20 attack routines, DR/SR, spatial envelopment, pack-driven AOE spells,
 * player hero participation, and detailed combat analytics.
 */
import type { RulesContext, RulesModule, UnitView } from "../core/rules";
import type { PRNG } from "../core/sim";
import type { ModelPool, Order } from "../core/strategic";
import { ModelStatus } from "../core/strategic";
import { err, ok, type OkOrErr } from "../core/result";
import { PF1E_MODEL_SCHEMA, PF1eProfileRegistry } from "./pf1e/schema";
import { buildUnitProfiles, seedPF1ePool } from "./pf1e/deploySeed";
import {
  pf1eRngFromPrng,
  resolvePF1eAttacks,
  resolvePF1eHealing,
  type PF1eRng,
} from "./pf1e/combatEngine";
import { calculatePF1eEnvelopment, PF1E_STATUS_FLANKED } from "./pf1e/envelopment";
import { resolvePF1eAOESpell } from "./pf1e/spells";
import {
  PF1E_PACK_FIREBALL_MASS_BATTLE,
  PF1E_PACK_BURNING_HANDS_MASS_BATTLE,
  parsePackSpellOrder,
  spellRangeFeet,
} from "./pf1e/spellPacks";
import { spellSaveDc } from "./pf1e/casting";
import { applyHeroLeadershipAuras } from "./pf1e/heroBridge";
import { deriveFromDocuments, parsePF1eActorSystem } from "./pf1e/actor";
import { PF1eBattleAnalyticsCollector, type UnitAnalyticsSummary } from "./pf1e/analytics";
import { SpatialGrid } from "../core/spatialGrid";
import { hasLineOfEffect, firstMoveBlock } from "../core/detection";

/**
 * Fireball's spell level (CRB p.283: "Level sorcerer/wizard 3", verified in D-151's R02
 * transcription). The pack's `level` table still carries a known content bug (5) with a
 * mangled key structure, so the sim keeps the verified constant until that table is
 * repaired wholesale — nothing reads it in the meantime (D-151).
 */
const FIREBALL_SPELL_LEVEL = 3;

/**
 * Burning Hands' spell level (CRB pg. 251: "Level … sorcerer 1, … wizard 1", verified in
 * D-171's R02 transcription). Like Fireball, the sim uses this verified constant rather
 * than reading the pack's `level` table (D-151).
 */
const BURNING_HANDS_SPELL_LEVEL = 1;

/** A spell the mass-battle module can fire: the pack entry plus its verified level. */
export interface PF1eMassSpellDef {
  entry: Readonly<Record<string, unknown>>;
  level: number;
}

/**
 * The spells the module can fire, keyed by the pack entry id an order names in
 * `data.spell` (default `fireball`). Every entry ships in `pf1e-core/packs/spells.json`;
 * the levels are the verified CRB constants, not the pack's `level` table (D-151).
 */
export const PF1E_MASS_SPELLS: Readonly<Record<string, PF1eMassSpellDef>> = Object.freeze({
  fireball: { entry: PF1E_PACK_FIREBALL_MASS_BATTLE, level: FIREBALL_SPELL_LEVEL },
  "burning-hands": { entry: PF1E_PACK_BURNING_HANDS_MASS_BATTLE, level: BURNING_HANDS_SPELL_LEVEL },
});

/** Orders that omit `data.spell` cast this spell (backwards compatibility). */
export const DEFAULT_MASS_SPELL_ID = "fireball";

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

export function createMassBattlePf1e(opts: MassBattlePf1eOptions = {}): RulesModule {
  const registry = new PF1eProfileRegistry();
  const grid = new SpatialGrid(5);
  // Campaign-lifetime analytics: one collector per module instance, NOT per turn — that is
  // what lets `forecast` answer with real accumulated totals (M11). Caveat: a SimWorker
  // restart starts a fresh collector, so totals only cover this module instance's turns.
  const analytics = new PF1eBattleAnalyticsCollector();

  // The module's spell list is the shipped registry; `opts.spellEntry` overrides the
  // default spell's entry (the test seam), leaving every other spell untouched.
  const spells: Record<string, PF1eMassSpellDef> = { ...PF1E_MASS_SPELLS };
  const defaultDef = spells[DEFAULT_MASS_SPELL_ID];
  if (opts.spellEntry && defaultDef) {
    spells[DEFAULT_MASS_SPELL_ID] = { entry: opts.spellEntry, level: defaultDef.level };
  }

  // Each spell's shape decides what a well-formed order looks like, so probe it once at
  // creation. An unparseable entry is not validated here — resolveTurn names the pack
  // issue per cast; it just defaults the shape to circle for validation purposes.
  const spellShapes = new Map<string, string>();
  for (const [id, def] of Object.entries(spells)) {
    const probe = parsePackSpellOrder({ entry: def.entry, casterLevel: 1 });
    spellShapes.set(id, probe.ok && probe.order ? probe.order.shape : "circle");
  }

  const subPhases = ["move", "heal", "shoot", "melee", "spell", "morale"] as const;

  const module: RulesModule = {
    schema: {
      version: "1.0.0",
      modelColumns: PF1E_MODEL_SCHEMA,
      unitTypes: PF1E_UNIT_TYPE_STATS as unknown as Record<string, import("../core/documents").Json>,
      orderTypes: ["move", "attack", "custom", "hold", "retreat"],
      subPhases: [...subPhases],
    },

    validateOrder(_ctx: RulesContext, _unit: UnitView, order: Order): OkOrErr {
      switch (order.kind) {
        case "move": {
          if (order.path.length === 0) return err("move: empty path");
          for (const p of order.path) {
            if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return err("move: NaN waypoint");
          }
          return ok;
        }
        case "attack":
          return order.targetUnitId ? ok : err("attack: missing targetUnitId");
        case "custom": {
          if (order.type !== "spell_aoe") return ok;
          const spellId = payloadSpellId(order.data);
          if (!spells[spellId]) return err(`spell_aoe: unknown spell "${spellId}"`);
          const shape = spellShapes.get(spellId) ?? "circle";
          const payload = parseSpellAoePayload(shape, order.data);
          return payload.ok ? ok : err(`spell_aoe: ${payload.message}`);
        }
        case "hold":
          return ok;
        case "retreat":
          return Number.isFinite(order.toward.x) && Number.isFinite(order.toward.y)
            ? ok
            : err("retreat: NaN destination");
        default:
          return ok;
      }
    },

    resolveTurn(ctx, pool, units, orders, rng, emit): void {
      // One grid cell in feet — the scene's authored grid distance (P01: scene metadata,
      // not constants), with the standard 5-ft fallback. Drives both the movement budget
      // (D-173) and envelopment reach (D-177).
      const cellFeet = Number.isFinite(ctx.grid.distance) && ctx.grid.distance > 0 ? ctx.grid.distance : 5;

      // ── flanking bits expire each round (M04, D-177). The envelopment engine sets
      // FLANKED on surrounded defenders, but nothing ever cleared it, so a bit set once
      // lingered for the rest of the battle (Gap List §5). Engagement is recomputed in
      // the melee sub-phase after movement, so the clear runs first thing in the round.
      // Bit 2 aliases core `ModelStatus.pinned` — the documented §2.13 status-column
      // collision; the PF1e module owns it as FLANKED until that column lands.
      for (let i = 0; i < pool.count; i++) {
        const st = pool.status[i] ?? 0;
        if ((st & PF1E_STATUS_FLANKED) !== 0) pool.status[i] = st & ~PF1E_STATUS_FLANKED;
      }

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
        if (!order || (order.kind !== "move" && order.kind !== "retreat")) continue;
        const typeStats = PF1E_UNIT_TYPE_STATS[unit.type as keyof typeof PF1E_UNIT_TYPE_STATS];
        const movePoints = typeStats?.move ?? 0;
        if (movePoints <= 0) continue;
        const anchor = anchorPosition(pool, unit);
        if (anchor === null) continue; // a unit with no living models cannot move

        let path: ReadonlyArray<{ x: number; y: number }>;
        let paceMul: number;
        if (order.kind === "retreat") {
          path = [order.toward];
          paceMul = 2; // SRD Withdraw: up to double speed
        } else {
          path = order.path;
          paceMul = order.pace === "run" ? 4 : order.pace === "charge" ? 2 : 1;
        }
        let remaining = movePoints * paceMul * cellFeet;
        let cx = anchor.x;
        let cy = anchor.y;
        const startX = cx;
        const startY = cy;
        let leg = 0;
        let hitWall = false;
        let traveled = 0;
        while (remaining > 0 && leg < path.length) {
          const wp = path[leg];
          if (!wp || !Number.isFinite(wp.x) || !Number.isFinite(wp.y)) break;
          const d = Math.hypot(wp.x - cx, wp.y - cy);
          if (d === 0) {
            leg++;
            continue;
          }
          // Movement-blocking walls (§0 wall contract, bit 0) clip the leg at the first
          // crossing (D-174): the formation stops just short of the wall and the rest of
          // the budget is spent — the sim never routes around obstacles (P03's job).
          const block = firstMoveBlock(cx, cy, wp.x, wp.y, ctx.walls);
          const traversable = block === null ? d : Math.max(0, block * d - MOVE_BLOCK_EPSILON);
          const step = Math.min(remaining, traversable);
          if (step > 0) {
            cx += ((wp.x - cx) / d) * step;
            cy += ((wp.y - cy) / d) * step;
            traveled += step;
          }
          remaining -= step;
          // Stopped at the wall: the march ends here — later waypoints lie beyond it.
          if (block !== null && step >= traversable) {
            hitWall = true;
            break;
          }
          if (step < d) break; // budget ran out before the waypoint
          leg++;
        }
        const dx = cx - startX;
        const dy = cy - startY;
        // A wall-blocked unit reports even a zero-distance attempt, so the GM sees why
        // the march went nowhere; otherwise a no-op move stays silent.
        if (dx === 0 && dy === 0 && !hitWall) continue;
        const [start, end] = unit.modelRange ?? [0, 0];
        for (let i = start; i < end && i < pool.count; i++) {
          if (((pool.status[i] ?? 0) & ModelStatus.dead) !== 0) continue;
          pool.x[i] = (pool.x[i] ?? 0) + dx;
          pool.y[i] = (pool.y[i] ?? 0) + dy;
          if (order.kind === "move" && order.facing !== undefined) pool.rot[i] = order.facing;
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
            // Observable to the GM: the march ended at a movement-blocking wall, not at
            // the path's end or the budget's limit.
            ...(hitWall ? { blockedByWall: true } : {}),
          },
        });
      }

      grid.rebuild(pool);

      // Profiles + derived pool columns (§1.3/§1.4). Interned from a deterministically
      // sorted unit list, so `profileIdx` values written into the pool stay valid across
      // turns, checkpoints and SimWorker restarts. Seeding also refreshes per-turn state:
      // the AoO budget resets (SRD: your attacks of opportunity refresh at the start of
      // your turn) and save/AC columns are rewritten before leadership auras are added,
      // which is what keeps an aura from stacking once per model per turn.
      const profiles = buildUnitProfiles(units, registry);
      seedPF1ePool(pool, units, profiles);

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
        if (!profile || (profile.fastHealingVal <= 0 && profile.regenerationVal <= 0)) continue;
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
            data: { healed: healRes.totalHealed, revived: healRes.revivedCount },
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
        const anchor = unit.modelRange?.[0];
        if (anchor === undefined) continue;
        applyHeroLeadershipAuras({ pool, grid, heroModelIdx: anchor, radius: 30, moraleBonus: 2 });
      }

      // Resolve Melee Engagements & Envelopment
      for (const unit of units) {
        const queue = orders.get(unit.id);
        const order = queue?.active ?? queue?.pending[0];
        if (!order || order.kind !== "attack" || !order.targetUnitId) continue;

        const targetUnit = units.find((u) => u.id === order.targetUnitId);
        if (!targetUnit) continue;

        const targetUnitIdx = units.indexOf(targetUnit);
        const attackerUnitIdx = units.indexOf(unit);

        // Calculate Spatial Envelopment. Reach is the scene's cell size in feet — the
        // 5-ft natural reach of a Medium creature on the standard grid (SRD Combat,
        // "Reach Weapons"), sourced from scene metadata per P01/D-177 rather than a
        // hardcoded constant.
        const envRes = calculatePF1eEnvelopment({
          pool,
          grid,
          attackerUnitIdx,
          defenderUnitIdx: targetUnitIdx,
          reach: cellFeet,
        });

        // Collect attacker and defender model indices
        const [aStart, aEnd] = unit.modelRange ?? [0, 0];
        const [dStart, dEnd] = targetUnit.modelRange ?? [0, 0];

        const attackers: number[] = [];
        for (let i = aStart; i < aEnd && i < pool.count; i++) {
          if (((pool.status[i] ?? 0) & ModelStatus.dead) === 0) attackers.push(i);
        }

        const defenders: number[] = [];
        for (let i = dStart; i < dEnd && i < pool.count; i++) {
          if (((pool.status[i] ?? 0) & ModelStatus.dead) === 0) defenders.push(i);
        }

        // Resolve PF1e Attack Loop. Dice come from the turn PRNG forked per unit
        // (§5A), never Math.random() — a seeded turn must replay identically.
        const combatRes = resolvePF1eAttacks({
          pool,
          attackers,
          defenders,
          registry,
          rng: forkRng(rng, unitIndex(unit), 1),
          isFlanked: envRes.envelopedDefenders.length > 0,
        });

        // Hero Cleave (D-178). Once per hero *unit* per engagement, SRD Cleave grants
        // "one extra melee attack at your full attack bonus against a foe adjacent to
        // you" (Gap List §5). It resolves as a real attack by the hero's lead model
        // against the first adjacent living defender — never the old overkill cascade,
        // which force-killed `defenders[0]` and splashed a literal 25 damage (the
        // rejected model, D-130). `maxIterativeAttacks: 1` keeps it to exactly one
        // attack regardless of the hero's iterative routine. Until actor feat data
        // exists, cleave rides the same `isHeroUnit` gate as the leadership aura.
        if (isHeroUnit(unit, ctx.leaderActors) && attackers.length > 0) {
          const heroIdx = attackers[0];
          if (heroIdx !== undefined) {
            const adjacentEnemy = grid
              .queryPoint(pool.x[heroIdx] ?? 0, pool.y[heroIdx] ?? 0, cellFeet, pool)
              .find((n) => pool.unitIdx[n.index] === targetUnitIdx)?.index;
            if (adjacentEnemy !== undefined) {
              const cleaveRes = resolvePF1eAttacks({
                pool,
                attackers: [heroIdx],
                defenders: [adjacentEnemy],
                registry,
                rng: forkRng(rng, unitIndex(unit), 3),
                isFlanked: envRes.envelopedDefenders.length > 0,
                maxIterativeAttacks: 1,
              });
              const merged = combatRes.metrics as unknown as Record<string, number>;
              for (const [key, value] of Object.entries(cleaveRes.metrics)) {
                merged[key] = (merged[key] ?? 0) + (value as number);
              }
              // SRD Cleave penalty (R03/D-130): "You take a −2 penalty to your Armor
              // Class until your next turn." Seeding rewrites the ac column from the
              // profile every round before melee, so the penalty is naturally wiped at
              // the start of the hero's next round — meanwhile enemy units resolved
              // later THIS round attack against the reduced AC.
              if (pool.sys["ac"]) pool.sys["ac"][heroIdx] = (pool.sys["ac"][heroIdx] ?? 0) - 2;
            }
          }
        }

        analytics.recordCombat(unit.id, combatRes.metrics);

        emit({
          subPhase: "melee",
          type: "attack",
          unitId: unit.id,
          targetUnitId: targetUnit.id,
          text: `${unit.name} attacks ${targetUnit.name}: ${combatRes.metrics.hits} hits, ${combatRes.metrics.netDamageDealt} damage, ${combatRes.metrics.killsCount} kills`,
          data: combatRes.metrics as unknown as Record<string, import("../core/documents").Json>,
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
        if (!order || order.kind !== "custom" || order.type !== "spell_aoe") continue;

        const refusal = (kind: string, reason: string): void => {
          emit({ subPhase: "spell", type: "spellRefused", unitId: unit.id, text: `${unit.name} cannot cast: ${reason}`, data: { refusal: kind, reason } });
        };

        // 0. Spell selection (D-171): the order names the pack entry it casts in
        // `data.spell`; no name means the default spell. Unknown ids are refused by name.
        const spellId = payloadSpellId(order.data);
        const spellDef = spells[spellId];
        if (!spellDef) {
          refusal("unknown_spell", `spell "${spellId}" is not in the mass-battle spell registry`);
          continue;
        }

        // 1. Location is order-driven: the payload carries the point of origin (circle)
        // or the aim direction (cone/line — those shoot away from the caster, CRB p.214).
        // The shape is the selected spell's, probed once at creation.
        const payload = parseSpellAoePayload(spellShapes.get(spellId) ?? "circle", order.data);
        if (!payload.ok) {
          refusal("bad_order", payload.message);
          continue;
        }

        // 2. Caster inputs are profile-driven. Missing stats fall back to the compiled
        // profile defaults (CL 1, key modifier +3) in `compilePF1eProfile`, never to a
        // constant at the call site.
        const profile = profiles.byUnitId.get(unit.id);
        if (!profile) {
          refusal("no_caster_profile", "the casting unit has no compiled profile");
          continue;
        }
        // 2b. M07: a leader actor bound to the unit outranks the unit-stats profile —
        // its authored caster level and key ability are the caster's real ones.
        const heroInputs = casterInputsFromLeaderActor(ctx.leaderActors[unit.id]);
        const casterLevel = heroInputs?.casterLevel ?? profile.casterLevel;
        const keyAbilityMod = heroInputs?.keyAbilityMod ?? profile.castingStatMod;
        const spellPenetration = heroInputs?.spellPenetration ?? profile.spellPenetration;

        // 3. Range is measured from the casting unit's anchor (first living model): a
        // spell's range is "the maximum distance at which you can designate the spell's
        // point of origin" (CRB p.213). A unit with no living models cannot cast at all.
        const anchor = anchorPosition(pool, unit);
        if (anchor === null) {
          refusal("no_living_caster", "the casting unit has no living models");
          continue;
        }

        // A caster who fails the defensive-cast check provokes — so the spell resolver
        // needs to know who threatens the anchor. A Medium creature threatens the squares
        // within its reach, i.e. 5 ft (CRB: reach / attacks of opportunity); coordinates
        // here are in feet, so the query radius is 5. Only living models of other units
        // can threaten (queryPoint already skips dead/hidden models).
        const casterAdjacentEnemies: number[] = [];
        for (const n of grid.queryPoint(anchor.x, anchor.y, 5, pool)) {
          const idx = n.index;
          if (pool.unitIdx[idx] === pool.unitIdx[anchor.idx]) continue;
          casterAdjacentEnemies.push(idx);
        }

        // 4. The pack payload is built at the caster's actual level — "1d6 per caster
        // level (maximum 10d6)" resolves against it — from the selected spell's entry.
        const packSpell = parsePackSpellOrder({ entry: spellDef.entry, casterLevel });
        if (!packSpell.ok || packSpell.order === null) {
          refusal("pack_issue", packSpell.issues.map((i) => i.message).join("; "));
          continue;
        }

        // Cone/line shapes start at the caster; only the circle designates a remote
        // point, so only it is checked against the range category and the designation
        // line of effect (CRB pp.213–214).
        const origin =
          packSpell.order.shape === "circle" ? { x: payload.x, y: payload.y } : { x: anchor.x, y: anchor.y };
        const rangeFeet =
          packSpell.order.rangeCategory !== null ? spellRangeFeet(packSpell.order.rangeCategory, casterLevel) : null;
        if (packSpell.order.shape === "circle") {
          if (rangeFeet === null) {
            refusal("pack_issue", `${packSpell.order.spellName}: circle shape without a range category`);
            continue;
          }
          const distFeet = Math.hypot(origin.x - anchor.x, origin.y - anchor.y);
          if (distFeet > rangeFeet) {
            refusal("out_of_range", `${packSpell.order.spellName}: the point of origin at ${Math.round(distFeet)} ft is beyond the ${packSpell.order.rangeCategory} range of ${rangeFeet} ft at caster level ${casterLevel}`);
            continue;
          }

          // 4b. "You must have a clear line of effect to the point of origin of any
          // spell you cast" (CRB p.214). A sight-blocking wall between the caster and
          // the designated point refuses the cast outright.
          if (!hasLineOfEffect(anchor.x, anchor.y, origin.x, origin.y, ctx.walls)) {
            refusal("no_line_of_effect", `${packSpell.order.spellName}: no line of effect from the caster to the point of origin at (${origin.x}, ${origin.y})`);
            continue;
          }
        }

        // 5. DC from the same formula the tactical engine uses, with the caster's own
        // key-ability modifier and the selected spell's verified level.
        const { dc: packDc, issues: dcIssues } = spellSaveDc({ spellLevel: spellDef.level, keyAbilityMod });
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
            ...(packSpell.order.widthFeet !== null ? { widthFeet: packSpell.order.widthFeet } : {}),
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
        });

        analytics.recordSpell(unit.id, spellRes.metrics);

        // Hit attribution (M11): the area affects models of ANY unit inside it (friendly
        // fire is rules-correct for an Area spell), so the outcome is booked per owning
        // unit — the event carries the breakdown, and `deathsCount` finally lands on the
        // unit that lost models rather than on the caster.
        const hitsByUnit = new Map<string, { modelsHit: number; damageDealt: number; kills: number }>();
        for (const outcome of spellRes.perModel) {
          const owner = units.find((u) => {
            const [start, end] = u.modelRange ?? [0, 0];
            return outcome.idx >= start && outcome.idx < end && outcome.idx < pool.count;
          });
          if (!owner) continue;
          const bucket = hitsByUnit.get(owner.id) ?? { modelsHit: 0, damageDealt: 0, kills: 0 };
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
            ...(spellRes.metrics as unknown as Record<string, import("../core/documents").Json>),
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
            hitsByUnit: Object.fromEntries(hitsByUnit) as unknown as import("../core/documents").Json,
          },
        });
      }
    },

    tick(ctx, pool, units, orders, rng, emit, dtSeconds): void {
      void ctx; void pool; void units; void orders; void rng; void emit; void dtSeconds;
    },

    detection(ctx, unit): number {
      void ctx; void unit;
      return 6;
    },

    forecast(_ctx, army) {
      void _ctx;
      // The collector lives as long as this module instance (all turns this worker has
      // resolved), so the forecast reports accumulated campaign totals for this army's
      // units — a SimWorker restart begins fresh accumulation (M11).
      const report = analytics.generateReport();
      const armyUnitIds = new Set(army.units.map((u) => u.id));
      const armyUnits = Object.values(report.units).filter((u) => armyUnitIds.has(u.unitId));
      const sum = (pick: (u: UnitAnalyticsSummary) => number): number =>
        armyUnits.reduce((acc, u) => acc + pick(u), 0);
      const totalAttacks = sum((u) => u.totalAttacks);
      const killsCount = sum((u) => u.killsCount);
      const netDamageDealt = sum((u) => u.netDamageDealt);
      const deathsCount = sum((u) => u.deathsCount);
      const rows = armyUnits
        .map((u) => ({ label: `${u.unitId}: net damage`, value: u.netDamageDealt }))
        .sort((a, b) => b.value - a.value);
      return {
        summary: `PF1e Army ${army.name}: ${totalAttacks} attacks, ${killsCount} kills, ${netDamageDealt} net damage${deathsCount > 0 ? `, ${deathsCount} models lost` : ""}`,
        rows,
        data: {
          totalAttacks,
          hits: sum((u) => u.hits),
          hitPercentage: totalAttacks > 0 ? Math.round((sum((u) => u.hits) / totalAttacks) * 100) : 0,
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
function forkRng(rng: PRNG, unitHash: number, phase: number): PF1eRng {
  return pf1eRngFromPrng(rng.fork(((unitHash << 4) | phase) >>> 0));
}

/**
 * A unit led by a player hero (Leadership aura, Cleave). Identity rides the unit
 * (`type: "hero"` or `stats.hero`) OR the M07 data path: a leader token bound to an
 * actor — which `collectLeaderActors` has already resolved into `ctx.leaderActors`
 * (keyed by unit id). Not a magic profile id: ids are assigned by content.
 */
function isHeroUnit(unit: UnitView, leaderActors: Readonly<Record<string, unknown>>): boolean {
  return unit.type === "hero" || unit.stats["hero"] === 1 || unit.id in leaderActors;
}

type SpellAoePayload =
  | { ok: true; x: number; y: number; dirX: number; dirY: number }
  | { ok: false; message: string };

const finiteNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * The `spell_aoe` order's `data`, per shape (CRB p.214):
 * - circle: `{ x, y }` — the designated point of origin, finite feet coordinates.
 * - cone/line: `{ dirX, dirY }` — the direction the spell shoots away from the caster;
 *   both finite, not both zero. Cones and lines start at the caster, so they take no
 *   point of origin.
 * Anything else is a named error rather than a silent fallback.
 */
function parseSpellAoePayload(shape: string, data: unknown): SpellAoePayload {
  const rec = typeof data === "object" && data !== null && !Array.isArray(data) ? (data as Record<string, unknown>) : null;
  if (rec === null) {
    return { ok: false, message: "order data must be an object like { x: 10, y: 10 } (circle) or { dirX: 1, dirY: 0 } (cone/line)" };
  }
  if (shape === "cone" || shape === "line") {
    if (!finiteNum(rec.dirX) || !finiteNum(rec.dirY) || (rec.dirX === 0 && rec.dirY === 0)) {
      return { ok: false, message: `order data needs finite, non-zero dirX and dirY — the direction the ${shape} shoots` };
    }
    return { ok: true, x: 0, y: 0, dirX: rec.dirX, dirY: rec.dirY };
  }
  if (!finiteNum(rec.x) || !finiteNum(rec.y)) {
    return { ok: false, message: "order data needs finite numeric x and y (the point of origin, in feet)" };
  }
  return { ok: true, x: rec.x, y: rec.y, dirX: 0, dirY: 0 };
}

/**
 * M07 seam — caster inputs from a leader actor document (RulesContext.leaderActors is
 * keyed by unit id). Runs the same tactical derivation the cast flow uses, so a hero's
 * authored caster level, key ability and Spell Penetration reach the strategic battle.
 * Returns null — and the caller keeps the unit-stats profile — when the document is
 * missing, unparseable, or the actor is not a caster (`spellCasterLevel` 0).
 */
export function casterInputsFromLeaderActor(
  actorJson: unknown,
): { casterLevel: number; keyAbilityMod: number; spellPenetration: number } | null {
  const doc = typeof actorJson === "object" && actorJson !== null && !Array.isArray(actorJson)
    ? (actorJson as Record<string, unknown>)
    : null;
  if (doc === null) return null;
  const system = typeof doc.system === "object" && doc.system !== null && !Array.isArray(doc.system)
    ? (doc.system as Record<string, unknown>)
    : null;
  if (system === null) return null;
  const derived = deriveFromDocuments({ actor: { system } });
  if (derived.spellCasterLevel <= 0) return null;
  const parsed = parsePF1eActorSystem(system.pf1e);
  return {
    casterLevel: derived.spellCasterLevel,
    keyAbilityMod: derived.abilityMods[derived.spellKeyAbility],
    spellPenetration: parsed.ok ? parsed.value.spellPenetration ?? 0 : 0,
  };
}

/**
 * Index + position (feet) of the unit's first living model, or null when none are alive.
 * The index matters for M11: it is the caster a threatened enemy swings at (defensive
 * casting AoO), not just the point range is measured from.
 */
function anchorPosition(pool: ModelPool, unit: UnitView): { idx: number; x: number; y: number } | null {
  const [start, end] = unit.modelRange ?? [0, 0];
  for (let i = start; i < end && i < pool.count; i++) {
    if (((pool.status[i] ?? 0) & ModelStatus.dead) === 0) {
      return { idx: i, x: pool.x[i] ?? 0, y: pool.y[i] ?? 0 };
    }
  }
  return null;
}
