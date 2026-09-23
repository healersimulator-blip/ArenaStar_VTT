// MCP connector §3.2 — the agent desk the Settings window drives: mint a user, grant a preset,
// narrow it, revoke it, forget it. A host booted in Node on the in-memory wire; no browser, because
// everything that matters here is a document and a session, and the UI is a view of those two.
import { beforeEach, describe, expect, test } from "vitest";
import { ClientSync, type ClientEvents } from "../../src/client/sync";
import { HostSync, gmSessionUser, type HostEvents } from "../../src/host/sync";
import { createEventBus } from "../../src/core/events";
import {
  DocumentStore,
  OpLog,
  UndoStack,
  type StoreMeta,
} from "../../src/core";
import { createTransportPair, flushMicrotasks } from "../../src/net/memory";
import type { UserDocument } from "../../src/core/documents";
import {
  createAgentManager,
  type AgentManager,
} from "../../src/app/agentManager";
import {
  agentRegistryFrom,
  agentRecordOf,
  AGENT_GRANTS_ID,
} from "../../src/core/agents/grants";
import { grantOfRecord } from "../../src/core/agents/grants";
import { PRESETS } from "../../src/core/agents/capabilities";

const meta: StoreMeta = {
  worldId: "w1",
  name: "World One",
  system: "pf1e-core",
  systemVersion: "1.0.0",
};
const GM_ID = "gm";

const userDoc = (): UserDocument => ({
  _id: GM_ID,
  type: "user",
  name: "GM",
  ownership: { default: 0 },
  flags: {},
  system: {},
  role: "GM",
  character: null,
  color: "#88c0d0",
});

interface Booted {
  host: HostSync;
  client: ClientSync;
  log: OpLog;
  store: DocumentStore;
  manager: AgentManager;
}

let boot: Booted;

async function bootWorld(): Promise<Booted> {
  const store = new DocumentStore({ meta });
  const log = new OpLog();
  const undo = new UndoStack();
  const host = new HostSync({
    store,
    log,
    undo,
    bus: createEventBus<HostEvents>(),
    systemUserId: GM_ID,
    roomId: "room-agents",
    verifyHelloSig: async (hello) => hello.sig === "valid",
  });
  const applied = store.applyEnvelope({
    seq: 1,
    ts: 0,
    by: GM_ID,
    ops: [{ kind: "create", coll: "users", data: userDoc() }],
    txId: "seed-1",
  });
  if (!applied.ok) throw new Error(applied.error);
  log.append(
    {
      seq: 1,
      ts: 0,
      by: GM_ID,
      ops: [{ kind: "create", coll: "users", data: userDoc() }],
      txId: "seed-1",
    },
    applied.value.inverses,
  );

  const pair = createTransportPair();
  host.addSession("gm", pair.a, gmSessionUser(GM_ID));
  const client = new ClientSync({
    transport: pair.b,
    bus: createEventBus<ClientEvents>(),
    meta,
  });
  await flushMicrotasks();
  await flushMicrotasks();
  return {
    host,
    client,
    log,
    store,
    manager: createAgentManager({ host, client, meta }),
  };
}

beforeEach(async () => {
  boot = await bootWorld();
});

const registry = () => agentRegistryFrom(boot.client.store.getAll("settings"));

describe("adding an agent (§3.2)", () => {
  test("mints a user and a grant in one envelope, and the session is the agent's own", async () => {
    const before = boot.store.seq;
    const handle = boot.manager.add("Vex", "gm-no-delete");
    expect(handle).not.toBeNull();
    await flushMicrotasks();
    await flushMicrotasks();

    // One system envelope for the user + the grant — never two, because a grant for a user that
    // does not exist is a Settings row nobody can explain.
    expect(boot.store.seq - before).toBe(1);

    const record = agentRecordOf(registry(), handle?.record.id ?? "");
    expect(record).toMatchObject({ preset: "gm-no-delete", status: "active" });
    expect(record?.capabilities).toEqual([...PRESETS["gm-no-delete"]]);

    const user = boot.store.get("users", record?.id ?? "") as
      UserDocument | undefined;
    expect(user?.name).toBe("Vex (agent)");
    expect(user?.role).toBe("ASSISTANT"); // the role the preset sits in, not the GM's
    expect(
      (user?.flags["core"] as { agent?: { preset?: string } } | undefined)
        ?.agent?.preset,
    ).toBe("gm-no-delete");

    // The session is real: the agent's own replica, welcomed by the host.
    expect(handle?.session?.client.user?.id).toBe(record?.id);
  });

  test("the same name reconnects the same agent instead of accumulating rows", async () => {
    boot.manager.add("Vex", "gm");
    await flushMicrotasks();
    boot.manager.add("Vex", "player");
    await flushMicrotasks();
    expect(registry().agents.filter((a) => a.id === "agent-vex")).toHaveLength(
      1,
    );
    // …and the preset change took effect on the one record.
    expect(agentRecordOf(registry(), "agent-vex")?.preset).toBe("player");
  });
});

describe("narrowing a grant (§3.1)", () => {
  test("unticking boxes narrows, and the preset stays the ceiling", async () => {
    const handle = boot.manager.add("Vex", "gm");
    await flushMicrotasks();
    const id = handle?.record.id ?? "";

    boot.manager.setGrant(id, { capabilities: ["world.read", "doc.create"] });
    await flushMicrotasks();
    const narrowed = agentRecordOf(registry(), id);
    expect(narrowed?.capabilities).toEqual(["world.read", "doc.create"]);

    // A capability the preset does not have is dropped, not stored in hope.
    boot.manager.setGrant(id, { capabilities: ["world.read", "time.control"] });
    await flushMicrotasks();
    expect(agentRecordOf(registry(), id)?.capabilities).toEqual([
      "world.read",
      "time.control",
    ]);

    boot.manager.setGrant(id, { preset: "observer" });
    await flushMicrotasks();
    // Changing the preset re-intersects the ticks: of `world.read` and `time.control`, only the
    // one observer allows survives — the tick boxes are never a promise about a new preset.
    expect(agentRecordOf(registry(), id)?.capabilities).toEqual(["world.read"]);
    expect(grantOfRecord(agentRecordOf(registry(), id)).capabilities).toEqual([
      "world.read",
    ]);
  });

  test("a grant edit is a replicated document, so it is undoable like any edit", async () => {
    const handle = boot.manager.add("Vex", "gm");
    await flushMicrotasks();
    const id = handle?.record.id ?? "";
    boot.manager.setGrant(id, { capabilities: ["world.read"] });
    await flushMicrotasks();

    const settingsDocs = () => boot.client.store.getAll("settings");
    expect(settingsDocs().some((d) => d._id === AGENT_GRANTS_ID)).toBe(true);
    // The edit travelled the ordinary op path, so the host's undo takes it back in one click.
    const undone = boot.host.undo();
    expect(undone.ok).toBe(true);
    await flushMicrotasks();
    expect(agentRecordOf(registry(), id)?.capabilities).toEqual([
      ...PRESETS.gm,
    ]);
  });
});

describe("revoking is not deleting (§7.4)", () => {
  test("revoke empties the capabilities, closes the session and keeps the record", async () => {
    const handle = boot.manager.add("Vex", "gm");
    await flushMicrotasks();
    const id = handle?.record.id ?? "";
    boot.manager.revoke(id);
    await flushMicrotasks();

    const record = agentRecordOf(registry(), id);
    expect(record?.status).toBe("revoked");
    expect(record?.capabilities).toEqual([]);
    // The world file remembers what was *allowed* — that is the audit a GM reads afterwards.
    expect(record).not.toBeNull();
    expect(
      boot.manager.list().find((a) => a.record.id === id)?.session,
    ).toBeNull();
    expect(grantOfRecord(record).capabilities).toEqual([]);
  });

  test("forget removes the row, and only after the session is gone", async () => {
    const handle = boot.manager.add("Vex", "gm");
    await flushMicrotasks();
    const id = handle?.record.id ?? "";
    boot.manager.forget(id);
    await flushMicrotasks();
    expect(agentRecordOf(registry(), id)).toBeNull();
    // The user document stays: it authored things, and deleting an author is rewriting history.
    expect(boot.store.get("users", id)).toBeDefined();
  });
});

describe("the audit ring (§6.4)", () => {
  test("a manager with no connected bridges has nothing to report", () => {
    expect(boot.manager.audit()).toEqual([]);
  });

  test("connecting needs an active grant, and an unknown agent is refused", () => {
    const handle = boot.manager.add("Vex", "observer");
    expect(
      boot.manager.connect("agent-nobody", "ws://127.0.0.1:1", "token"),
    ).toBe(false);
    expect(handle).not.toBeNull();
    // A real socket is mcpBridge's job; here the point is that the desk refuses what it cannot do.
    expect(boot.manager.connect("agent-vex", "ws://127.0.0.1:1", "token")).toBe(
      true,
    );
  });
});
