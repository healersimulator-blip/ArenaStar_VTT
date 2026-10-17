import "fake-indexeddb/auto";
import { expect, test } from "vitest";
import { openVttDb, putSetting } from "../../src/storage/idb";
import {
  loadRecentGames,
  saveRecentGame,
  removeRecentGame,
} from "../../src/app/recentGames";

test("recent games validates stored records, sorts, replaces a room and removes it", async () => {
  const db = await openVttDb();
  await putSetting(db, {
    scope: "client",
    key: "recentGames",
    value: [
      null,
      {},
      { roomId: 42 },
      {
        roomId: "old",
        inviteLink: "#room=old",
        hostWorldName: "Old",
        lastPlayedAt: 1,
      },
    ],
  });
  expect((await loadRecentGames(db)).map((row) => row.roomId)).toEqual(["old"]);
  await saveRecentGame(db, {
    roomId: "new",
    inviteLink: "#room=new",
    hostWorldName: "New",
    lastPlayedAt: 2,
    playerName: "Wizard",
  });
  expect((await loadRecentGames(db)).map((row) => row.roomId)).toEqual([
    "new",
    "old",
  ]);
  await saveRecentGame(db, {
    roomId: "old",
    inviteLink: "#room=old",
    hostWorldName: "Renamed",
    lastPlayedAt: 3,
  });
  expect(await loadRecentGames(db)).toHaveLength(2);
  expect((await loadRecentGames(db))[0]?.hostWorldName).toBe("Renamed");
  await removeRecentGame(db, "old");
  expect((await loadRecentGames(db)).map((row) => row.roomId)).toEqual(["new"]);
  db.close();
});
