import { describe, expect, test } from "vitest";
import { createEventBus } from "../../src/core/events";
import type { MessageDocument } from "../../src/core/documents";
import type { OpsMsg, RejectedMsg, SnapshotMsg, WireMessage } from "../../src/core/messages";
import type { OpEnvelope } from "../../src/core/ops";
import { ClientSync, type ClientEvents, type OptimisticPolicy } from "../../src/client/sync";
import { channelFor, deframeMessage, frameMessage } from "../../src/net/frame";
import { createTransportPair, flushMicrotasks } from "../../src/net/memory";

const meta = { worldId: "w-image-ack", name: "Image Ack", system: "mass-battle-basic", systemVersion: "1.0.0" };

async function readyClient(optimistic?: OptimisticPolicy): Promise<{
  pair: ReturnType<typeof createTransportPair>;
  client: ClientSync;
}> {
  const pair = createTransportPair();
  const client = new ClientSync({ transport: pair.b, bus: createEventBus<ClientEvents>(), meta, ...(optimistic ? { optimistic } : {}) });
  const snapshot: SnapshotMsg = {
    kind: "snapshot",
    seq: 0,
    world: {
      worldId: meta.worldId,
      name: meta.name,
      system: meta.system,
      systemVersion: meta.systemVersion,
      seq: 0,
      collections: { users: [], messages: [] } as never,
      assetManifest: {},
    },
    manifest: {},
  } as unknown as SnapshotMsg;
  pair.a.send(channelFor("snapshot"), frameMessage(snapshot));
  await flushMicrotasks();
  return { pair, client };
}

function message(id: string): MessageDocument {
  return {
    _id: id,
    type: "message",
    name: "Image action test",
    ownership: { default: 1 },
    flags: {},
    system: {},
    author: "gm",
    content: "Committed image action",
    whisper: [],
    roll: null,
    flavor: "",
  };
}

describe("ClientSync.submitAndWait image document intents", () => {
  test("resolves only after the matching host commit is applied", async () => {
    const { pair, client } = await readyClient();
    pair.a.onMessage = (_channel, bytes) => {
      const decoded = deframeMessage(bytes);
      if (!decoded.ok || decoded.value.kind !== "intent") return;
      const intent = decoded.value;
      const envelope: OpEnvelope = {
        seq: 1,
        ts: 10,
        by: "gm",
        txId: intent.txId,
        ops: intent.ops,
      };
      pair.a.send(channelFor("ops"), frameMessage({ kind: "ops", envelope } satisfies OpsMsg));
    };

    const txId = await client.submitAndWait([{ kind: "create", coll: "messages", data: message("image-action") }]);
    expect(client.store.get("messages", "image-action")?.content).toBe("Committed image action");
    expect(txId).toBeTruthy();
  });

  test("rejects when the host rejects the matching transaction", async () => {
    const { pair, client } = await readyClient();
    pair.a.onMessage = (_channel, bytes) => {
      const decoded = deframeMessage(bytes);
      if (!decoded.ok || decoded.value.kind !== "intent") return;
      const rejection: RejectedMsg = {
        kind: "rejected",
        txId: decoded.value.txId,
        reason: "forbidden",
        detail: "scene write permission was revoked",
      };
      pair.a.send(channelFor("rejected"), frameMessage(rejection as WireMessage));
    };

    await expect(client.submitAndWait([{ kind: "create", coll: "messages", data: message("rejected-image-action") }]))
      .rejects.toThrow(/forbidden: scene write permission was revoked/);
    expect(client.store.get("messages", "rejected-image-action")).toBeUndefined();
  });

  test("times out without leaving the optimistic echo pending", async () => {
    // Every op is optimistic here, so the in-flight echo visibly carries the create.
    const { pair, client } = await readyClient(() => true);
    // The host stays silent: no commit, no rejection.
    pair.a.onMessage = () => {};

    const waiting = client.submitAndWait([{ kind: "create", coll: "messages", data: message("silent-image-action") }], 5);
    const outcome = expect(waiting).rejects.toThrow(/did not acknowledge/);
    // While the intent is in flight, the optimistic echo shows it.
    expect(client.echo.get("messages", "silent-image-action")).toBeDefined();
    await outcome;
    expect(client.store.get("messages", "silent-image-action")).toBeUndefined();
    expect(client.echo.get("messages", "silent-image-action")).toBeUndefined();
  });
});
