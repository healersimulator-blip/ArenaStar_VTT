// MCP connector §3.2 — the grant is a replicated document: what it reads back as, how it narrows a
// preset, and the ops that change it.
import { describe, expect, test } from "vitest";
import {
  agentGrantDocument,
  agentRegistryFrom,
  agentRecordOf,
  capabilitiesFor,
  forgetAgentOps,
  grantOfRecord,
  revokeAgentOps,
  upsertAgentOps,
  AGENT_GRANTS_ID,
  type AgentRecord,
} from "../../src/core/agents/grants";
import {
  AGENT_CAPABILITIES,
  PRESETS,
} from "../../src/core/agents/capabilities";
import {
  agentDisplayName,
  agentIdFor,
  agentUserDoc,
} from "../../src/app/agentSession";

const record = (over: Partial<AgentRecord> = {}): AgentRecord => ({
  id: "agent-vex",
  name: "Vex (agent)",
  preset: "gm-no-delete",
  capabilities: capabilitiesFor("gm-no-delete"),
  sceneScope: null,
  status: "active",
  auditNote: false,
  client: "claude-desktop",
  since: 7,
  ...over,
});

const settingsDocs = (agents: unknown[]) => [
  {
    _id: AGENT_GRANTS_ID,
    type: "settings",
    name: "Agent grants",
    ownership: { default: 1 },
    flags: {},
    system: { grants: agents },
  },
];

describe("the registry reads back what it was given (§3.2)", () => {
  test("a round trip keeps the record", () => {
    const registry = agentRegistryFrom(settingsDocs([record()]));
    expect(registry.agents).toHaveLength(1);
    expect(registry.agents[0]).toMatchObject({
      id: "agent-vex",
      preset: "gm-no-delete",
      status: "active",
      client: "claude-desktop",
    });
    expect(agentRecordOf(registry, "agent-nope")).toBeNull();
  });

  test("a half-written record is tolerated, and never widened", () => {
    const registry = agentRegistryFrom(
      settingsDocs([
        {
          id: "agent-x",
          preset: "player",
          capabilities: ["doc.delete", "not-a-capability", 7],
        },
        { id: "agent-y", preset: "nonsense", capabilities: null },
        { noId: true },
        "a string",
      ]),
    );
    expect(registry.agents.map((a) => a.id)).toEqual(["agent-x", "agent-y"]);
    // `doc.delete` is not in the `player` preset: a stored list is intersected on the way in too,
    // because presets can shrink between versions.
    expect(registry.agents[0]?.capabilities).toEqual([]);
    expect(registry.agents[1]?.preset).toBe("observer");
    expect(registry.agents[1]?.status).toBe("pending");
  });

  test("an empty or missing bag is an empty registry, not an error", () => {
    expect(agentRegistryFrom([]).agents).toEqual([]);
    expect(agentRegistryFrom(settingsDocs([])).agents).toEqual([]);
  });
});

describe("capabilities narrow, never widen (§3.1)", () => {
  test("a picked superset is clipped to the preset", () => {
    expect(capabilitiesFor("player", AGENT_CAPABILITIES)).toEqual([
      ...PRESETS.player,
    ]);
    expect(capabilitiesFor("player", ["dice.roll", "doc.delete"])).toEqual([
      "dice.roll",
    ]);
    expect(capabilitiesFor("observer")).toEqual([...PRESETS.observer]);
  });
});

describe("the grant the bridge enforces", () => {
  test("an active agent gets the preset, narrowed by the ticks", () => {
    const grant = grantOfRecord(
      record({ capabilities: ["world.read", "doc.create"] }),
    );
    expect(grant.role).toBe("ASSISTANT"); // gm-no-delete sits in ASSISTANT (§3.1)
    expect(grant.capabilities).toEqual(["world.read", "doc.create"]);
    expect(grant.capabilities).not.toContain("doc.delete");
  });

  test("pending and revoked agents get nothing, and the role still comes from the preset", () => {
    for (const status of ["pending", "revoked"] as const) {
      const grant = grantOfRecord(record({ status }));
      expect(grant.capabilities).toEqual([]);
      expect(grant.role).toBe("ASSISTANT");
    }
    // An agent that connects before the GM has looked at it must not be able to read the world —
    // "no record" is a grant with nothing in it, not the preset's defaults.
    expect(grantOfRecord(null)).toEqual({
      role: "PLAYER",
      preset: "observer",
      capabilities: [],
    });
  });
});

describe("the ops", () => {
  test("the first grant creates the document, later ones update it", () => {
    const created = upsertAgentOps([], record());
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ kind: "create", coll: "settings" });
    expect(agentGrantDocument([record()])._id).toBe(AGENT_GRANTS_ID);

    const docs = settingsDocs([record({ id: "agent-other" })]);
    const updated = upsertAgentOps(docs, record());
    expect(updated).toHaveLength(1);
    expect(updated[0]).toMatchObject({
      kind: "update",
      ref: { coll: "settings", id: AGENT_GRANTS_ID },
    });
    // Both agents, sorted by id — a stable order is what keeps two replicas identical.
    const diff = (updated[0] as { diff: Record<string, unknown> }).diff;
    const next = diff["system.grants"] as Array<{ id: string }>;
    expect(next.map((a) => a.id)).toEqual(["agent-other", "agent-vex"]);
  });

  test("revoke empties the capabilities and keeps the record", () => {
    const docs = settingsDocs([record()]);
    const ops = revokeAgentOps(docs, "agent-vex");
    const diff = (ops[0] as { diff: Record<string, unknown> }).diff;
    const next = diff["system.grants"] as Array<{
      id: string;
      status: string;
      capabilities: string[];
    }>;
    expect(next[0]).toMatchObject({ status: "revoked", capabilities: [] });
    // The world file records what was *allowed*, which is the §7.4 audit a GM reads after the fact.
    expect(agentRegistryFrom(settingsDocs(next)).agents[0]?.status).toBe(
      "revoked",
    );
    expect(revokeAgentOps(docs, "agent-nobody")).toEqual([]);
  });

  test("forget removes it; forgetting what is not there is a no-op", () => {
    const docs = settingsDocs([record(), record({ id: "agent-other" })]);
    const diff = (
      forgetAgentOps(docs, "agent-vex")[0] as { diff: Record<string, unknown> }
    ).diff;
    expect(
      (diff["system.grants"] as Array<{ id: string }>).map((a) => a.id),
    ).toEqual(["agent-other"]);
    expect(forgetAgentOps(docs, "agent-nobody")).toEqual([]);
    expect(forgetAgentOps([], "agent-vex")).toEqual([]);
  });
});

describe("the agent's identity", () => {
  test("the id is stable, so a reload finds the same agent", () => {
    expect(agentIdFor("Vex")).toBe("agent-vex");
    expect(agentIdFor("Vex")).toBe(agentIdFor("vex"));
    expect(agentIdFor("Goblin Boss #2")).toBe("agent-goblin-boss-2");
    expect(agentIdFor("!!!")).toBe("agent-unnamed");
  });

  test("the name says it is an agent, once", () => {
    expect(agentDisplayName("Vex")).toBe("Vex (agent)");
    expect(agentDisplayName("Vex (agent)")).toBe("Vex (agent)");
    expect(agentDisplayName("  ")).toBe("Agent (agent)");
  });

  test("the user document carries the preset, and the role that preset sits in", () => {
    const doc = agentUserDoc({
      id: "agent-vex",
      name: "Vex",
      preset: "player",
      client: "claude",
    });
    expect(doc).toMatchObject({
      _id: "agent-vex",
      type: "user",
      role: "PLAYER",
      character: null,
    });
    expect(doc.name).toBe("Vex (agent)");
    expect(
      (doc.flags["core"] as { agent: { preset: string; client: string } })
        .agent,
    ).toEqual({
      preset: "player",
      client: "claude",
    });
  });
});
