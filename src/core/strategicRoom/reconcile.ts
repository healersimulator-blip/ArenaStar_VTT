import { actionDocHash } from "../actionRevert";
import type { ActorDocument, BaseDocument, Json, SceneDocument } from "../documents";
import type { FlatDiff, Op } from "../ops";
import type { DocumentStore } from "../store";
import {
  record,
  STRATEGIC_SPELL_CATALOG,
  type BattleReconciliationPayload,
  type StrategicSpellId,
} from "./protocol";
import { normalizedSceneForLaunchCheck } from "./campaignScene";

export interface ReconciliationConflict {
  coll: string;
  id: string;
  name: string;
  reason: string;
}

export interface ReconciliationAnalysis {
  conflicts: ReconciliationConflict[];
  unitChanges: number;
  actorResourceChanges: number;
  sceneChanges: number;
}

function normalizedSceneVariants(scene: SceneDocument): SceneDocument[] {
  const base = normalizedSceneForLaunchCheck(scene);
  const variants: SceneDocument[] = [base, scene];
  if (base.levels !== undefined) {
    const withoutLevels = { ...base };
    delete withoutLevels.levels;
    variants.push(withoutLevels);
  }
  return variants;
}

export function analyzeBattleReconciliation(
  store: DocumentStore,
  sceneId: string,
  payload: BattleReconciliationPayload,
): ReconciliationAnalysis {
  const conflicts: ReconciliationConflict[] = [];
  for (const dep of payload.projection?.dependencies ?? []) {
    if (!["scenes", "armies", "factions", "actors"].includes(dep.coll)) continue;
    const current = store.get(
      dep.coll as "scenes" | "armies" | "factions" | "actors",
      dep.id,
    ) as BaseDocument | undefined;
    if (!current) {
      conflicts.push({
        coll: dep.coll,
        id: dep.id,
        name: dep.id,
        reason: "Document was deleted in the campaign after battle launch.",
      });
      continue;
    }
    if (dep.coll === "scenes" && dep.id === sceneId) {
      const matchesLaunch = normalizedSceneVariants(current as SceneDocument).some(
        (cand) => actionDocHash(cand) === dep.digest,
      );
      if (!matchesLaunch) {
        conflicts.push({
          coll: dep.coll,
          id: dep.id,
          name: current.name || dep.id,
          reason: "Scene was modified in the campaign after battle launch.",
        });
      }
      continue;
    }
    const nowDigest = actionDocHash(current);
    if (nowDigest !== dep.digest) {
      conflicts.push({
        coll: dep.coll,
        id: dep.id,
        name: current.name || dep.id,
        reason: `${dep.coll.slice(0, -1)} was modified in the campaign after battle launch (seq > ${payload.projection?.sourceSeq ?? 0}).`,
      });
    }
  }

  let unitChanges = 0;
  let actorResourceChanges = 0;
  for (const u of payload.units ?? []) {
    if (u.lost > 0 || u.at !== null || (u.conditions?.length ?? 0) > 0) unitChanges++;
    if (
      Object.values(u.spellsSpent ?? {}).some((n) => n > 0) ||
      Object.values(u.itemsSpent ?? {}).some((n) => n > 0) ||
      (u.conditions?.length ?? 0) > 0
    ) {
      actorResourceChanges++;
    }
  }
  const sceneChanges =
    Object.keys(payload.doorStates ?? {}).length +
    (payload.darkness !== undefined ? 1 : 0);

  return { conflicts, unitChanges, actorResourceChanges, sceneChanges };
}

/**
 * Build a single atomic, undoable `Op[]` envelope reconciling accepted battle mutations
 * back into the campaign `DocumentStore`. By default (`skipConflicted: true`), any document
 * edited independently since launch is skipped rather than overwritten.
 */
export function buildBattleReconciliationOps(
  store: DocumentStore,
  sceneId: string,
  payload: BattleReconciliationPayload,
  options: { skipConflicted?: boolean } = {},
): { ops: Op[]; reconciledUnits: number; skippedConflicts: number } {
  const skipConflicted = options.skipConflicted ?? true;
  const analysis = analyzeBattleReconciliation(store, sceneId, payload);
  const conflictedKeys = new Set(analysis.conflicts.map((c) => `${c.coll}:${c.id}`));
  const isBlocked = (coll: string, id: string) => skipConflicted && conflictedKeys.has(`${coll}:${id}`);

  const scene = store.get("scenes", sceneId);
  if (!scene) throw new Error("Target battle scene no longer exists.");
  const gridSize = Math.max(1, scene.grid.size);
  const ops: Op[] = [];
  let reconciledUnits = 0;
  let skippedConflicts = 0;

  // Track cumulative per-actor resource/condition updates in case one actor leads multiple units
  const actorSpellSpent = new Map<string, Map<StrategicSpellId, number>>();
  const actorItemSpent = new Map<string, Map<string, number>>();
  const actorConditions = new Map<string, Set<string>>();

  for (const u of payload.units ?? []) {
    const src = u.source;
    if (src?.kind === "armyUnit" && src.armyId && src.unitId) {
      if (isBlocked("armies", src.armyId)) {
        skippedConflicts++;
      } else {
        const army = store.get("armies", src.armyId);
        const armyUnit = army?.units.find((cand) => cand._id === src.unitId);
        if (army && armyUnit) {
          const unitDiff: FlatDiff = {
            "stats.strength": Math.max(0, u.alive),
          };
          if (u.at) {
            unitDiff["profile.anchor"] = {
              x: Math.round(u.at.x * 100) / 100,
              y: Math.round(u.at.y * 100) / 100,
            } as unknown as Json;
          }
          const entangleSpent = u.spellsSpent?.["entangle"] ?? 0;
          if (entangleSpent > 0 && typeof armyUnit.stats.entangleSlots === "number") {
            unitDiff["stats.entangleSlots"] = Math.max(0, armyUnit.stats.entangleSlots - entangleSpent);
          }
          ops.push({
            kind: "update",
            ref: { coll: "units", id: src.unitId, parent: { coll: "armies", id: src.armyId } },
            diff: unitDiff,
          });
          reconciledUnits++;
        }
      }
    }

    if (src?.tokenId && !isBlocked("scenes", sceneId)) {
      const token = scene.tokens.find((t) => t._id === src.tokenId);
      if (token) {
        const tokDiff: FlatDiff = record(token.flags?.core)
          ? { "flags.core.strategicStrength": Math.max(0, u.alive) }
          : { "flags.core": { strategicStrength: Math.max(0, u.alive) } as unknown as Json };
        if (u.alive <= 0) {
          tokDiff.hidden = true;
        } else if (u.at) {
          tokDiff.x = Math.round((u.at.x / 5) * gridSize - token.width / 2);
          tokDiff.y = Math.round((u.at.y / 5) * gridSize - token.height / 2);
          if (u.facing !== undefined && Number.isFinite(u.facing)) {
            const deg = ((Math.round((u.facing * 180) / Math.PI) % 360) + 360) % 360;
            tokDiff.rotation = deg;
          }
        }
        ops.push({
          kind: "update",
          ref: { coll: "tokens", id: token._id, parent: { coll: "scenes", id: sceneId } },
          diff: tokDiff,
        });
        if (src.kind === "token") reconciledUnits++;
      }
    }

    const actorId = src?.actorId;
    if (actorId) {
      for (const [spellId, count] of Object.entries(u.spellsSpent ?? {})) {
        if (count <= 0 || !(spellId in STRATEGIC_SPELL_CATALOG)) continue;
        let map = actorSpellSpent.get(actorId);
        if (!map) actorSpellSpent.set(actorId, (map = new Map()));
        const key = spellId as StrategicSpellId;
        map.set(key, (map.get(key) ?? 0) + count);
      }
      for (const [itemId, count] of Object.entries(u.itemsSpent ?? {})) {
        if (count <= 0) continue;
        let map = actorItemSpent.get(actorId);
        if (!map) actorItemSpent.set(actorId, (map = new Map()));
        map.set(itemId, (map.get(itemId) ?? 0) + count);
      }
      if (u.conditions?.length) {
        let set = actorConditions.get(actorId);
        if (!set) actorConditions.set(actorId, (set = new Set()));
        for (const c of u.conditions) set.add(c);
      }
    }
  }

  // Apply Actor spell-slot, item-charge, and condition write-backs
  const touchedActors = new Set([
    ...actorSpellSpent.keys(),
    ...actorItemSpent.keys(),
    ...actorConditions.keys(),
  ]);
  for (const actorId of touchedActors) {
    if (isBlocked("actors", actorId)) {
      skippedConflicts++;
      continue;
    }
    const actor = store.get("actors", actorId) as ActorDocument | undefined;
    if (!actor) continue;
    const actorDiff: FlatDiff = {};
    const pf1e = record(actor.system?.pf1e) ? actor.system.pf1e : {};
    const spells = record(pf1e.spells) ? pf1e.spells : null;
    const spentSpells = actorSpellSpent.get(actorId);
    if (spells && spentSpells && spentSpells.size > 0) {
      if (spells.mode === "spontaneous") {
        const slotsUsed = record(spells.slotsUsed) ? { ...spells.slotsUsed } : {};
        for (const [spellId, count] of spentSpells) {
          const lvl = String(STRATEGIC_SPELL_CATALOG[spellId].level);
          const prev = typeof slotsUsed[lvl] === "number" ? (slotsUsed[lvl] as number) : 0;
          slotsUsed[lvl] = prev + count;
        }
        actorDiff["system.pf1e.spells.slotsUsed"] = slotsUsed as unknown as Json;
      } else if (Array.isArray(spells.prepared)) {
        const nextPrepared = spells.prepared.map((row) =>
          record(row) ? { ...row } : row,
        );
        for (const [spellId, count] of spentSpells) {
          const targetName = STRATEGIC_SPELL_CATALOG[spellId].name.toLowerCase();
          let remaining = count;
          for (const row of nextPrepared) {
            if (remaining <= 0) break;
            if (
              record(row) &&
              typeof row.name === "string" &&
              (row.name.trim().toLowerCase() === targetName ||
                row.name.trim().toLowerCase() === spellId) &&
              !row.expended
            ) {
              row.expended = true;
              remaining--;
            }
          }
        }
        actorDiff["system.pf1e.spells.prepared"] = nextPrepared as unknown as Json;
      }
    }

    const conds = actorConditions.get(actorId);
    if (conds && conds.size > 0) {
      const existing = Array.isArray(pf1e.conditions)
        ? pf1e.conditions.filter((c): c is string => typeof c === "string")
        : [];
      const merged = [...new Set([...existing, ...conds])].slice(0, 16);
      if (record(actor.system?.pf1e)) {
        actorDiff["system.pf1e.conditions"] = merged as unknown as Json;
      } else {
        actorDiff["system.pf1e"] = { conditions: merged } as unknown as Json;
      }
    }

    if (Object.keys(actorDiff).length > 0) {
      ops.push({
        kind: "update",
        ref: { coll: "actors", id: actorId },
        diff: actorDiff,
      });
    }

    const spentItems = actorItemSpent.get(actorId);
    if (spentItems) {
      for (const [itemId, count] of spentItems) {
        const item = actor.items.find((cand) => cand._id === itemId);
        if (!item) continue;
        const isys = record(item.system) ? item.system : {};
        const ipf1e = record(isys.pf1e) ? isys.pf1e : null;
        const itemDiff: FlatDiff = {};
        if (ipf1e && typeof ipf1e.charges === "number") {
          itemDiff["system.pf1e.charges"] = Math.max(0, ipf1e.charges - count);
        } else if (ipf1e && typeof ipf1e.quantity === "number") {
          itemDiff["system.pf1e.quantity"] = Math.max(0, ipf1e.quantity - count);
        } else if (typeof isys.charges === "number") {
          itemDiff["system.charges"] = Math.max(0, isys.charges - count);
        } else if (typeof isys.quantity === "number") {
          itemDiff["system.quantity"] = Math.max(0, isys.quantity - count);
        }
        if (Object.keys(itemDiff).length > 0) {
          ops.push({
            kind: "update",
            ref: { coll: "items", id: itemId, parent: { coll: "actors", id: actorId } },
            diff: itemDiff,
          });
        }
      }
    }
  }

  // Apply door state changes on the scene
  if (payload.doorStates && !isBlocked("scenes", sceneId)) {
    for (const [wallId, doorState] of Object.entries(payload.doorStates)) {
      const wall = scene.walls.find((w) => w._id === wallId);
      if (wall && wall.door !== doorState) {
        ops.push({
          kind: "update",
          ref: { coll: "walls", id: wallId, parent: { coll: "scenes", id: sceneId } },
          diff: { door: doorState },
        });
      }
    }
  }

  // Always release the hosted battle binding and record the audit summary on the scene
  const lastHostedBattle = {
    id: payload.id,
    version: payload.version,
    ...(payload.surviving !== undefined ? { surviving: payload.surviving } : {}),
    ...(payload.lost !== undefined ? { lost: payload.lost } : {}),
    ...(payload.projection?.sourceSeq !== undefined
      ? { sourceSeq: payload.projection.sourceSeq }
      : {}),
    reconciledUnits,
    skippedConflicts,
    reconciledAt: Date.now(),
  } as unknown as Json;
  const sceneDiff: FlatDiff = record(scene.flags?.core)
    ? {
        "-=flags.core.campaignBattle": null,
        "flags.core.lastHostedBattle": lastHostedBattle,
      }
    : {
        "flags.core": { lastHostedBattle } as unknown as Json,
      };
  if (
    payload.darkness !== undefined &&
    !isBlocked("scenes", sceneId) &&
    Math.abs(scene.darkness - payload.darkness) > 0.001
  ) {
    sceneDiff.darkness = payload.darkness;
  }
  ops.push({
    kind: "update",
    ref: { coll: "scenes", id: sceneId },
    diff: sceneDiff,
  });

  return { ops, reconciledUnits, skippedConflicts };
}
