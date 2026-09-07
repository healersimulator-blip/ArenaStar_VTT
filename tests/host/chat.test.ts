import "fake-indexeddb/auto";
import { describe, expect, test } from "vitest";
import { DEFAULT_SCENE_ID } from "../../src/app/hostBoot";
import { projectWorld } from "../../src/core/projection";
import type { MessageDocument } from "../../src/core/documents";
import { boot, settle } from "../app/fakes";

function chatMessage(id: string, content: string, whisper: string[] = []): MessageDocument {
  return {
    _id: id,
    type: "message",
    name: content.slice(0, 40) || "message",
    ownership: { default: 1 },
    flags: {},
    system: {},
    author: "gm",
    content,
    whisper,
    roll: null,
    flavor: "",
  };
}

describe("chat rolls (§10/§11, host-resolved)", () => {
  test("inline [[formula]] resolved on the host into [[total|formula]] chips", async () => {
    const app = await boot();
    try {
      app.gm.client.submit([
        {
          kind: "create",
          coll: "messages",
          data: chatMessage("m-1", "attack [[1d20+3]] vs AC, damage [[1d6]]"),
        },
      ]);
      await settle();
      const messages = app.store.getAll("messages") as MessageDocument[];
      expect(messages).toHaveLength(1);
      expect(messages[0]?.content).toMatch(/\[\[\d+\|1d20\+3\]\]/);
      expect(messages[0]?.content).toMatch(/\[\[[1-6]\|1d6\]\]/);
      expect(messages[0]?.content).toContain("attack");
      expect(messages[0]?.content).toContain("vs AC, damage");
    } finally {
      await app.persister.flush();
      app.close();
    }
  });

  test("invalid inline formulas stay literal text (never silently dropped)", async () => {
    const app = await boot();
    try {
      app.gm.client.submit([
        {
          kind: "create",
          coll: "messages",
          data: chatMessage("m-2", "see [[banana]] and [[1d20+3]]"),
        },
      ]);
      await settle();
      const mine = (app.store.getAll("messages") as MessageDocument[]).find((m) => m._id === "m-2");
      expect(mine?.content).toContain("[[banana]]");
      expect(mine?.content).toMatch(/\[\[\d+\|1d20\+3\]\]/);
    } finally {
      await app.persister.flush();
      app.close();
    }
  });

  test("/roll wire message commits a roll card; gmroll redacted for other players (§5)", async () => {
    const app = await boot();
    try {
      app.gm.client.roll("1d20+5", "roll");
      app.gm.client.roll("1d20", "gmroll");
      await settle(6);
      const messages = app.store.getAll("messages") as MessageDocument[];
      const plain = messages.find((m) => m.roll?.formula === "1d20+5");
      const secret = messages.find((m) => m.roll?.formula === "1d20");
      expect(plain).toBeDefined();
      expect(secret).toBeDefined();
      expect(plain?.roll?.total).toBeGreaterThanOrEqual(6);
      expect(plain?.roll?.total).toBeLessThanOrEqual(25);
      expect(plain?.author).toBe("gm");
      expect(secret?.rollMode).toBe("gmroll");

      // a PLAYER's projection keeps the public card but redacts the gm one
      const projected = projectWorld(app.store.world, app.store.seq, {
        id: "player-x",
        role: "PLAYER",
      });
      const projectedSecret = (projected.collections.messages ?? []).find(
        (m) => m.rollMode === "gmroll",
      );
      expect(projectedSecret).toBeDefined();
      expect(projectedSecret?.roll).toBeNull(); // redact: GM eyes only
      const projectedPlain = (projected.collections.messages ?? []).find(
        (m) => m.roll?.formula === "1d20+5",
      );
      expect(projectedPlain?.roll?.total).toBe(plain?.roll?.total);

      // whisper omission for unrelated players
      app.gm.client.submit([
        {
          kind: "create",
          coll: "messages",
          data: chatMessage("m-w", "psst", ["someone-else"]),
        },
      ]);
      await settle();
      const projected2 = projectWorld(app.store.world, app.store.seq, {
        id: "player-x",
        role: "PLAYER",
      });
      expect((projected2.collections.messages ?? []).some((m) => m.content === "psst")).toBe(false);
      const scene = app.store.get("scenes", DEFAULT_SCENE_ID);
      void scene;
    } finally {
      await app.persister.flush();
      app.close();
    }
  });
});
