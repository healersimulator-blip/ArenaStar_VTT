/** Player-side "games you played" persistence (D-489 follow-up). */
import type { IDBPDatabase } from "idb";
import { getSetting, putSetting } from "../storage/idb";

export interface RecentGame {
  roomId: string;
  inviteLink: string;
  hostWorldName: string;
  lastPlayedAt: number;
  hostPubkey?: string;
  /** The name this player used in this game (world-specific; not a global default). */
  playerName?: string;
}

const SCOPE = "client";
const KEY = "recentGames";

export async function loadRecentGames(db: IDBPDatabase): Promise<RecentGame[]> {
  const rec = await getSetting(db, SCOPE, KEY);
  const value = rec?.value as unknown;
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is RecentGame => !!entry && typeof entry === "object")
    .sort((a, b) => b.lastPlayedAt - a.lastPlayedAt);
}

export async function saveRecentGame(db: IDBPDatabase, game: RecentGame): Promise<void> {
  const existing = await loadRecentGames(db);
  const next = [game, ...existing.filter((entry) => entry.roomId !== game.roomId)];
  // Keep a modest history.
  const trimmed = next.slice(0, 20);
  await putSetting(db, { scope: SCOPE, key: KEY, value: trimmed as never });
}

export async function removeRecentGame(db: IDBPDatabase, roomId: string): Promise<void> {
  const existing = await loadRecentGames(db);
  await putSetting(db, {
    scope: SCOPE,
    key: KEY,
    value: existing.filter((entry) => entry.roomId !== roomId) as never,
  });
}
