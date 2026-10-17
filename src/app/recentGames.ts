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

/** IDB is untrusted input too (older builds, partial writes, browser extensions). */
function isRecentGame(value: unknown): value is RecentGame {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.roomId === "string" &&
    row.roomId.length > 0 &&
    typeof row.inviteLink === "string" &&
    row.inviteLink.length > 0 &&
    typeof row.hostWorldName === "string" &&
    typeof row.lastPlayedAt === "number" &&
    Number.isFinite(row.lastPlayedAt) &&
    (row.hostPubkey === undefined || typeof row.hostPubkey === "string") &&
    (row.playerName === undefined || typeof row.playerName === "string")
  );
}

export async function loadRecentGames(db: IDBPDatabase): Promise<RecentGame[]> {
  const rec = await getSetting(db, SCOPE, KEY);
  const value = rec?.value as unknown;
  if (!Array.isArray(value)) return [];
  return value
    .filter(isRecentGame)
    .sort((a, b) => b.lastPlayedAt - a.lastPlayedAt);
}

export async function saveRecentGame(
  db: IDBPDatabase,
  game: RecentGame,
): Promise<void> {
  const existing = await loadRecentGames(db);
  const next = [
    game,
    ...existing.filter((entry) => entry.roomId !== game.roomId),
  ];
  // Keep a modest history.
  const trimmed = next.slice(0, 20);
  await putSetting(db, {
    scope: SCOPE,
    key: KEY,
    value: trimmed.map((row) => ({ ...row })),
  });
}

export async function removeRecentGame(
  db: IDBPDatabase,
  roomId: string,
): Promise<void> {
  const existing = await loadRecentGames(db);
  await putSetting(db, {
    scope: SCOPE,
    key: KEY,
    value: existing
      .filter((entry) => entry.roomId !== roomId)
      .map((row) => ({ ...row })),
  });
}
