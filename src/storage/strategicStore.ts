/**
 * §8A strategic persistence: checkpoints (compressed ModelPool + unitStats +
 * seed + rulesVersion + hash), turnReports (compressed JSON), simdeltas
 * (ring buffer, last M). Retention: every checkpoint of the last 10 turns,
 * then every 5th. Included in world.zip export/import (see worldFile.ts).
 */
import { strFromU8, strToU8 } from "fflate";
import { compressSync, decompressSync } from "fflate";
import type { IDBPDatabase } from "idb";
import type { TurnReport } from "../core/sim";
import type { DocId, WorldId } from "../core/ids";
import type { Json } from "../core/documents";
import { STORES } from "./idb";

export interface CheckpointRecord {
  worldId: WorldId;
  sceneId: DocId;
  /** turnNumber (stepwise) or tick (realtime) — the §8A key third part. */
  slot: number;
  turnNumber: number;
  tick: number | null;
  pool: Uint8Array;
  maxHpMax: number;
  version: number;
  unitStats: Record<string, Json>;
  seed: number;
  rulesVersion: string;
  hash: string;
}

export interface TurnReportRecord {
  worldId: WorldId;
  sceneId: DocId;
  turnNumber: number;
  /** fflate-compressed JSON of the TurnReport. */
  bytes: Uint8Array;
}

export interface SimDeltaRecord {
  worldId: WorldId;
  sceneId: DocId;
  version: number;
  bytes: Uint8Array;
  maxHpMax: number;
  at: number;
}

/** Ring buffer size for simdeltas per scene (§8A "keep last M"). */
export const SIMDELTA_RING = 50;
/** Keep every checkpoint of the last N turns, then every 5th (§8A). */
export const CHECKPOINT_RECENT_TURNS = 10;
export const CHECKPOINT_STRIDE = 5;

export async function putCheckpoint(db: IDBPDatabase, rec: CheckpointRecord): Promise<void> {
  await db.put(STORES.checkpoints, rec);
}

export async function latestCheckpoint(
  db: IDBPDatabase,
  worldId: WorldId,
  sceneId: DocId,
): Promise<CheckpointRecord | null> {
  const range = IDBKeyRange.bound([worldId, sceneId, -Infinity], [worldId, sceneId, Infinity]);
  let best: CheckpointRecord | null = null;
  let cursor = await db.transaction(STORES.checkpoints).store.openCursor(range);
  while (cursor) {
    best = cursor.value as CheckpointRecord;
    cursor = await cursor.continue();
  }
  return best;
}

export async function listCheckpoints(
  db: IDBPDatabase,
  worldId: WorldId,
  sceneId: DocId,
): Promise<CheckpointRecord[]> {
  const out: CheckpointRecord[] = [];
  let cursor = await db
    .transaction(STORES.checkpoints)
    .store.openCursor(
      IDBKeyRange.bound([worldId, sceneId, -Infinity], [worldId, sceneId, Infinity]),
    );
  while (cursor) {
    out.push(cursor.value as CheckpointRecord);
    cursor = await cursor.continue();
  }
  return out;
}

export async function applyCheckpointRetention(
  db: IDBPDatabase,
  worldId: WorldId,
  sceneId: DocId,
  currentTurn: number,
  recent = CHECKPOINT_RECENT_TURNS,
  stride = CHECKPOINT_STRIDE,
): Promise<number> {
  const all = await listCheckpoints(db, worldId, sceneId);
  const tx = db.transaction(STORES.checkpoints, "readwrite");
  const store = tx.store;
  let removed = 0;
  for (const rec of all) {
    const isRecent = currentTurn - rec.turnNumber < recent;
    const isStride = rec.turnNumber % stride === 0;
    if (!isRecent && !isStride) {
      await store.delete([rec.worldId, rec.sceneId, rec.slot]);
      removed++;
    }
  }
  await tx.done;
  return removed;
}

export function encodeReport(report: TurnReport): Uint8Array {
  return compressSync(strToU8(JSON.stringify(report)));
}

export function decodeReport(bytes: Uint8Array): TurnReport {
  return JSON.parse(strFromU8(decompressSync(bytes))) as TurnReport;
}

export async function putReport(
  db: IDBPDatabase,
  worldId: WorldId,
  sceneId: DocId,
  report: TurnReport,
): Promise<void> {
  await db.put(STORES.turnReports, {
    worldId,
    sceneId,
    turnNumber: report.turn,
    bytes: encodeReport(report),
  } satisfies TurnReportRecord);
}

export async function getReport(
  db: IDBPDatabase,
  worldId: WorldId,
  sceneId: DocId,
  turnNumber: number,
): Promise<TurnReport | null> {
  const rec = (await db.get(STORES.turnReports, [worldId, sceneId, turnNumber])) as
    TurnReportRecord | undefined;
  return rec ? decodeReport(rec.bytes) : null;
}

export async function listReports(
  db: IDBPDatabase,
  worldId: WorldId,
  sceneId: DocId,
): Promise<TurnReport[]> {
  const out: TurnReport[] = [];
  let cursor = await db
    .transaction(STORES.turnReports)
    .store.openCursor(
      IDBKeyRange.bound([worldId, sceneId, -Infinity], [worldId, sceneId, Infinity]),
    );
  while (cursor) {
    out.push(decodeReport((cursor.value as TurnReportRecord).bytes));
    cursor = await cursor.continue();
  }
  return out.sort((a, b) => a.turn - b.turn);
}

export async function putDelta(db: IDBPDatabase, rec: SimDeltaRecord): Promise<void> {
  const tx = db.transaction(STORES.simdeltas, "readwrite");
  await tx.store.put(rec);
  // ring buffer: prune oldest beyond M for this scene
  const range = IDBKeyRange.bound(
    [rec.worldId, rec.sceneId, -Infinity],
    [rec.worldId, rec.sceneId, Infinity],
  );
  const keys: number[] = [];
  let cursor = await tx.store.openCursor(range);
  while (cursor) {
    keys.push((cursor.value as SimDeltaRecord).version);
    cursor = await cursor.continue();
  }
  if (keys.length > SIMDELTA_RING) {
    keys.sort((a, b) => a - b);
    for (const k of keys.slice(0, keys.length - SIMDELTA_RING)) {
      await tx.store.delete([rec.worldId, rec.sceneId, k]);
    }
  }
  await tx.done;
}

export async function listDeltas(
  db: IDBPDatabase,
  worldId: WorldId,
  sceneId: DocId,
): Promise<SimDeltaRecord[]> {
  const out: SimDeltaRecord[] = [];
  let cursor = await db
    .transaction(STORES.simdeltas)
    .store.openCursor(
      IDBKeyRange.bound([worldId, sceneId, -Infinity], [worldId, sceneId, Infinity]),
    );
  while (cursor) {
    out.push(cursor.value as SimDeltaRecord);
    cursor = await cursor.continue();
  }
  return out.sort((a, b) => a.version - b.version);
}

// ─── world-wide listings (world.zip export, §8A) ─────────────────────────────

export async function listCheckpointsForWorld(
  db: IDBPDatabase,
  worldId: WorldId,
): Promise<CheckpointRecord[]> {
  const out: CheckpointRecord[] = [];
  let cursor = await db.transaction(STORES.checkpoints).store.openCursor();
  while (cursor) {
    const rec = cursor.value as CheckpointRecord;
    if (rec.worldId === worldId) out.push(rec);
    cursor = await cursor.continue();
  }
  return out.sort((a, b) =>
    a.sceneId === b.sceneId ? a.slot - b.slot : a.sceneId < b.sceneId ? -1 : 1,
  );
}

export async function listReportsForWorld(
  db: IDBPDatabase,
  worldId: WorldId,
): Promise<TurnReportRecord[]> {
  const out: TurnReportRecord[] = [];
  let cursor = await db.transaction(STORES.turnReports).store.openCursor();
  while (cursor) {
    const rec = cursor.value as TurnReportRecord;
    if (rec.worldId === worldId) out.push(rec);
    cursor = await cursor.continue();
  }
  return out.sort((a, b) =>
    a.sceneId === b.sceneId ? a.turnNumber - b.turnNumber : a.sceneId < b.sceneId ? -1 : 1,
  );
}
