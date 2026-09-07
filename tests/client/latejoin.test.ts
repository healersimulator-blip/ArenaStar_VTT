import { describe, expect, test } from "vitest";
import { createEventBus } from "../../src/core/events";
import { ClientSync, type ClientEvents } from "../../src/client/sync";
import { createTransportPair, flushMicrotasks } from "../../src/net/memory";
import { channelFor, frameMessage } from "../../src/net/frame";
import type { OpsMsg, SnapshotMsg } from "../../src/core/messages";
import type { OpEnvelope } from "../../src/core/ops";
import type { MessageDocument } from "../../src/core/documents";

const wire = (host: ReturnType<typeof createTransportPair>["a"], msg: unknown): void => {
  const kind = (msg as { kind: string }).kind === "ops" ? "ops" : "snapshot";
  host.send(channelFor(kind as never), frameMessage(msg as never));
};

describe("late join (§14): buffered ops seq > snapshot.seq apply after it", () => {
  test("ops that raced the snapshot buffer, then apply in order once it lands", async () => {
    const pair = createTransportPair();
    const host = pair.a;
    const player = pair.b;

    const bus = createEventBus<ClientEvents>();
    const client = new ClientSync({
      transport: player,
      bus,
      meta: {
        worldId: "w-lj",
        name: "Late Join",
        system: "mass-battle-basic",
        systemVersion: "1.0.0",
      },
    });

    // The join races host commits: envelopes 4 and 5 arrive BEFORE the
    // snapshot (seq 3) — the client must buffer them, then apply in order.
    const message = (id: string, content: string): MessageDocument => ({
      _id: id,
      type: "message",
      name: "m",
      ownership: { default: 1 },
      flags: {},
      system: {},
      author: "gm",
      content,
      whisper: [],
      roll: null,
      flavor: "",
    });
    const env4: OpEnvelope = {
      seq: 4,
      ts: 1,
      by: "gm",
      txId: "t4",
      ops: [{ kind: "create" as const, coll: "messages" as const, data: message("m4", "fourth") }],
    };
    const env5: OpEnvelope = {
      seq: 5,
      ts: 2,
      by: "gm",
      txId: "t5",
      ops: [{ kind: "create" as const, coll: "messages" as const, data: message("m5", "fifth") }],
    };
    wire(host, { kind: "ops", envelope: env4 } satisfies OpsMsg);
    await flushMicrotasks();
    wire(host, { kind: "ops", envelope: env5 } satisfies OpsMsg);
    await flushMicrotasks();
    expect(client.store.seq).toBe(0); // buffered, nothing applied

    const snapshot = {
      kind: "snapshot",
      seq: 3,
      world: {
        worldId: "w-lj",
        name: "Late Join",
        system: "mass-battle-basic",
        systemVersion: "1.0.0",
        seq: 3,
        collections: {
          users: [
            {
              _id: "gm",
              type: "user",
              name: "GM",
              ownership: { default: 3 },
              flags: {},
              system: {},
              role: "GM",
              character: null,
              color: "#fff",
            },
          ],
          messages: [],
        },
        assetManifest: {},
      },
      manifest: {},
    } as unknown as SnapshotMsg;
    wire(host, snapshot);
    await flushMicrotasks();

    // snapshot applied, then the buffered 4 and 5 in order
    expect(client.store.seq).toBe(5);
    expect(client.store.get("messages", "m4")?.content).toBe("fourth");
    expect(client.store.get("messages", "m5")?.content).toBe("fifth");
  });
});
