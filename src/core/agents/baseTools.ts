/**
 * MCP connector §5.1 — the session and world tools: the three an agent calls first, and the two it
 * calls again whenever it loses track of where it is.
 */
import { AGENT_CAPABILITIES } from "./capabilities";
import type { Json } from "../documents";
import type { ToolDefinition, ToolResult } from "./types";

export const whoami: ToolDefinition = {
  name: "whoami",
  description:
    "The agent's own identity: its name, role, preset and the capabilities its grant allows. Costs nothing and is never refused — call it first when a call comes back denied.",
  args: { properties: {} },
  capability: null,
  run(_args, ctx): ToolResult {
    const me = ctx.view.identity();
    const granted = ctx.grant.capabilities;
    const withheld = AGENT_CAPABILITIES.filter((c) => !granted.includes(c));
    // Two different roles are in play and they are not the same thing: the **session** is whose
    // replica the reads come from, and the **grant** is what the GM allowed this agent to do with
    // them. In Phase 0/1 the bridge is hosted by the GM's tab, so the session says GM while a grant
    // may say observer — and an agent that reads "role GM" and stops there would draw exactly the
    // wrong conclusion. Say both, and say which one is the ceiling.
    const narrower = me !== null && ctx.grant.role !== me.role;
    const lines = [
      me
        ? `You are "${me.name}" (${me.id}) — session role ${me.role} (your reads come from this session's replica).`
        : "No session is bound yet.",
      `Grant: preset "${ctx.grant.preset}", role ${ctx.grant.role}${
        narrower
          ? " — narrower than the session, and it is the ceiling on your tools"
          : ""
      }.`,
      `Capabilities (${granted.length}): ${granted.join(", ") || "none"}.`,
      withheld.length > 0
        ? `Withheld (${withheld.length}): ${withheld.join(", ")}.`
        : "Withheld: none.",
    ];
    return {
      content: [{ type: "text", text: lines.join("\n") }],
      structuredContent: {
        identity: me as unknown as Json,
        role: ctx.grant.role,
        preset: ctx.grant.preset,
        capabilities: granted as unknown as Json,
        withheld: withheld as unknown as Json,
      },
    };
  },
};

export const worldInfo: ToolDefinition = {
  name: "world.info",
  description:
    "The world's name, system and version, the replica's sequence number, and how many documents each collection holds. The cheapest way to find out where you are.",
  args: { properties: {} },
  capability: "world.read",
  run(_args, ctx): ToolResult {
    const world = ctx.view.worldInfo();
    const counts = Object.entries(world.collections)
      .filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([coll, n]) => `${coll} ${n}`);
    const body = [
      `World "${world.name}" (${world.id}) — system ${world.system} ${world.version}, seq ${world.seq}.`,
      counts.length > 0
        ? `Documents: ${counts.join(", ")}.`
        : "Documents: none yet.",
    ].join("\n");
    return {
      content: [{ type: "text", text: body }],
      structuredContent: {
        id: world.id,
        name: world.name,
        system: world.system,
        version: world.version,
        seq: world.seq,
        collections: world.collections as unknown as Json,
      },
    };
  },
};

/**
 * §5.1's `world.snapshot`: the "has anything changed?" poll. It carries **no document data** — an
 * agent that wants to know whether to re-read a scene asks this, not `scene.read`, and the answer is
 * a handful of integers even on a world with 25,000 entries.
 */
export const worldSnapshot: ToolDefinition = {
  name: "world.snapshot",
  description:
    "Counts per collection and the replica's sequence number — nothing else. Poll it to see whether anything changed since the seq you last saw; then read the thing that changed.",
  args: { properties: {} },
  capability: "world.read",
  run(_args, ctx): ToolResult {
    const snapshot = ctx.view.snapshot();
    const counts = Object.entries(snapshot.collections)
      .filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([coll, n]) => `${coll} ${n}`);
    return {
      content: [
        {
          type: "text",
          text: `seq ${snapshot.seq}${
            counts.length > 0 ? ` — ${counts.join(", ")}` : " — empty world"
          }.`,
        },
      ],
      structuredContent: {
        seq: snapshot.seq,
        collections: snapshot.collections as unknown as Json,
        clockSeconds: ctx.view.clockSeconds(),
      },
    };
  },
};

export const BASE_TOOLS: readonly ToolDefinition[] = [
  whoami,
  worldInfo,
  worldSnapshot,
];
