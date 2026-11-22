import { actionDocHash } from "../actionRevert";
import type { ActorDocument, BaseDocument, CollectionName, Json, SceneDocument } from "../documents";
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
  /** "edit" = document changed since launch; "missing" = deleted since launch. */
  kind: "edit" | "missing";
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
    // Every coll the launch signed (scenes/armies/factions/actors + content docs).
    const current = store.get(
      dep.coll as CollectionName,
      dep.id,
    ) as BaseDocument | undefined;
    if (!current) {
      conflicts.push({
        coll: dep.coll,
        id: dep.id,
        name: dep.id,
        reason: "Document was deleted in the campaign after battle launch.",
        kind: "missing",
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
          kind: "edit",
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
        kind: "edit",
      });
    }
  }

  // Missing deployment pieces (not an edit-after-launch conflict — the doc is gone):
  // units reference armies and scene tokens; record a conflict per missing piece so
  // the preview and the reconciliation audit can show why those writes cannot happen.
  const missingRecordKeys = new Set<string>();
  for (const u of payload.units ?? []) {
    const src = u.source;
    if (!src) continue;
    if (src.kind === "armyUnit" && src.armyId) {
      const army = store.get("armies", src.armyId);
      if (!army) {
        const key = `armies:${src.armyId}`;
        if (!missingRecordKeys.has(key)) {
          missingRecordKeys.add(key);
          conflicts.push({
            coll: "armies",
            id: src.armyId,
            name: src.armyId,
            reason: "Army was deleted in the campaign after battle launch.",
            kind: "missing",
          });
        }
      } else if (src.unitId && !army.units.some((cand) => cand._id === src.unitId)) {
        const key = `armies:${src.armyId}:${src.unitId}`;
        if (!missingRecordKeys.has(key)) {
          missingRecordKeys.add(key);
          conflicts.push({
            coll: "armies",
            id: src.armyId,
            name: src.unitId,
            reason: `Army unit "${src.unitId}" was deleted in the campaign after battle launch.`,
            kind: "missing",
          });
        }
      }
    }
    if (src.tokenId) {
      const scene = store.get("scenes", sceneId);
      if (scene && !scene.tokens.some((t) => t._id === src.tokenId)) {
        const key = `tokens:${src.tokenId}`;
        if (!missingRecordKeys.has(key)) {
          missingRecordKeys.add(key);
          conflicts.push({
            coll: "tokens",
            id: src.tokenId,
            name: src.tokenId,
            reason: "Token was deleted in the campaign after battle launch.",
            kind: "missing",
          });
        }
      }
    }
  }

  // Count real deltas, not "any living unit": a unit "changed" only when the battle
  // removed models or consumed resources. Conditions are only recounted when the
  // payload carries the launch-to-finish delta (`conditionsAdded`); a raw
  // `conditions` list is launch-time truth and can't distinguish a battle-added
  // condition from a pre-battle one, so it never counts as a change by itself.
  let unitChanges = 0;
  let actorResourceChanges = 0;
  for (const u of payload.units ?? []) {
    const spellsSpentTotal = Object.values(u.spellsSpent ?? {}).reduce((sum, n) => sum + n, 0);
    const itemsSpentTotal = Object.values(u.itemsSpent ?? {}).reduce((sum, n) => sum + n, 0);
    const conditionsAdded = u.conditionsAdded?.length ?? 0;
    if (
      u.lost > 0 ||
      u.alive !== u.initialStrength ||
      spellsSpentTotal > 0 ||
      itemsSpentTotal > 0 ||
      conditionsAdded > 0
    ) {
      unitChanges++;
    }
    if (spellsSpentTotal > 0 || itemsSpentTotal > 0 || conditionsAdded > 0) {
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
 * edited independently since launch is skipped rather than overwritten — for an army branch
 * that includes the unit, its scene token, and its actor's spell/item/condition write-back.
 * Missing deployment pieces (army/unit/token deleted since launch) raise a conflict record and
 * are skipped as well; `skippedConflicts` counts per-piece missing skips and per-unit blocked
 * skips.
 */
export function buildBattleReconciliationOps(
  store: DocumentStore,
  sceneId: string,
  payload: BattleReconciliationPayload,
  options: { skipConflicted?: boolean } = {},
): { ops: Op[]; reconciledUnits: number; skippedConflicts: number } {
  const skipConflicted = options.skipConflicted ?? true;
  const analysis = analyzeBattleReconciliation(store, sceneId, payload);
  // Only edit-after-launch conflicts gate ops; "missing" conflicts are handled
  // by explicit existence checks below (nothing exists to write there).
  const conflictedKeys = new Set(
    analysis.conflicts.filter((c) => c.kind === "edit").map((c) => `${c.coll}:${c.id}`),
  );
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

  // Pieces that existed but cannot be written (missing army/unit/token) raise a
  // skipped-conflict bump keyed by the piece; missing pieces never reach the ops list.
  const missingPieceBumps = new Set<string>();
  const bumpMissing = (key: string) => {
    if (missingPieceBumps.has(key)) return;
    missingPieceBumps.add(key);
    skippedConflicts++;
  };

  for (const u of payload.units ?? []) {
    const src = u.source;
    // skipUnit: the army branch was skipped (edit-after-launch conflict, or the
    // army/unit no longer exists) — skip unit + token + actor write-back for it.
    let skipUnit = false;
    if (src?.kind === "armyUnit" && src.armyId && src.unitId) {
      if (isBlocked("armies", src.armyId)) {
        skippedConflicts++;
        skipUnit = true;
      } else {
        const army = store.get("armies", src.armyId);
        const armyUnit = army?.units.find((cand) => cand._id === src.unitId);
        if (!army) {
          bumpMissing(`army:${src.armyId}`);
          skipUnit = true;
        } else if (!armyUnit) {
          bumpMissing(`unit:${src.armyId}:${src.unitId}`);
          skipUnit = true;
        } else {
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

    // A token that does not exist in the scene is a missing piece: record it once.
    if (src?.tokenId && !scene.tokens.some((t) => t._id === src.tokenId)) {
      bumpMissing(`token:${src.tokenId}`);
    }

    if (!skipUnit && src?.tokenId && !isBlocked("scenes", sceneId)) {
      const token = scene.tokens.find((t) => t._id === src.tokenId);
      if (token) {
        const tokDiff: FlatDiff = record(token.flags?.core)
          ? { "flags.core.strategicStrength": Math.max(0, u.alive) }
          : { "flags.core": { strategicStrength: Math.max(0, u.alive) } as unknown as Json };
        if (u.alive <= 0) {
          tokDiff.hidden = true;
        } else if (u.at) {
          // Token x/y is the CENTER: anchor_ft/5*gridSize, never a half-token offset.
          tokDiff.x = Math.round((u.at.x / 5) * gridSize);
          tokDiff.y = Math.round((u.at.y / 5) * gridSize);
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

    // Actor write-back is gated on the unit branch too: a conflicted army (or a
    // missing army/unit) skips the unit + token + actor; a missing token skips only the
    // token, and the missed piece is recorded as a conflict. The audit records provenance.
    const actorId = src?.actorId;
    if (!skipUnit && actorId) {
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
      // Use conditions added since launch when the payload provides it; fall back
      // to the raw list for older/hand-built payloads (a superset — still idempotent).
      const conds = u.conditionsAdded ?? u.conditions ?? [];
      if (conds.length) {
        let set = actorConditions.get(actorId);
        if (!set) actorConditions.set(actorId, (set = new Set()));
        for (const c of conds) set.add(c);
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
