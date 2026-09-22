/**
 * MCP connector §3.1 — **an agent is a user with its own session**, not a mask on the GM's.
 *
 * This is the single decision the rest of Phase 2 stands on. The obvious implementation is to keep
 * using the GM's `ClientSync` and remember "this write came from the agent" somewhere on the side.
 * It is also the wrong one, because the host stamps `OpEnvelope.by` from the *session's* user id
 * (`host/sync.ts:842`), and there is no way to claim a different author:
 *
 * | with a mask on the GM's session | with the agent's own session |
 * |---|---|
 * | `by` is the GM — the OpLog, the undo stack and the world file blame the GM for the agent's writes | `by` is the agent, so attribution is free (§3.1) |
 * | the agent reads the GM's replica, so every read tool has to re-implement redaction | the host sends this session a **projected** envelope (`host/sync.ts:1004`), so redaction is the projection's job, done once, in the one place it is already proved |
 * | the host validates as GM, so a bug in the bridge is a bug in the security boundary | the host validates against the agent's role, so the boundary is where it always was |
 *
 * The cost is a second `ClientSync` in the GM's tab, over an in-memory transport pair — the same
 * loopback the GM's own session rides (`hostBoot.ts:552`). It is not a second replica of anything
 * the player shells do not already hold: it is one more session, and sessions are what this app is
 * made of.
 */
import { ClientSync } from "../client/sync";
import { createEventBus } from "../core/events";
import { createTransportPair } from "../net/memory";
import type { HostSync } from "../host/sync";
import type { StoreMeta } from "../core/store";
import type { UserDocument } from "../core/documents";
import { OWNERSHIP_LEVELS } from "../core/documents";
import type { Op } from "../core/ops";
import type { AgentCapability, AgentPreset } from "../core/agents/capabilities";
import { PRESET_ROLE } from "../core/agents/capabilities";
import {
  capabilitiesFor,
  upsertAgentOps,
  type AgentRecord,
  type AgentStatus,
} from "../core/agents/grants";

/** §3.2: chat cards, the turn tracker and the GM's own list all read this name. */
export const AGENT_NAME_SUFFIX = " (agent)";

/**
 * A stable id derived from the name, so re-opening "Vex" after a reload finds the *same* user
 * document and the same grant instead of accumulating a row per connection.
 */
export function agentIdFor(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `agent-${slug || "unnamed"}`;
}

export function agentDisplayName(name: string): string {
  const trimmed = name.trim();
  if (trimmed === "") return `Agent${AGENT_NAME_SUFFIX}`;
  return trimmed.endsWith(AGENT_NAME_SUFFIX)
    ? trimmed
    : `${trimmed}${AGENT_NAME_SUFFIX}`;
}

export interface AgentUserOptions {
  id: string;
  name: string;
  preset: AgentPreset;
  client?: string | null;
}

/** The user document. Host-authoritative: `validateOps` refuses a client-authored `users` create. */
export function agentUserDoc(options: AgentUserOptions): UserDocument {
  return {
    _id: options.id,
    type: "user",
    name: agentDisplayName(options.name),
    ownership: { default: OWNERSHIP_LEVELS.NONE },
    flags: {
      core: {
        agent: {
          preset: options.preset,
          client: options.client ?? null,
        },
      },
    },
    system: {},
    role: PRESET_ROLE[options.preset],
    character: null,
    color: "#9a9ab0",
  };
}

export interface OpenAgentSessionOptions {
  host: HostSync;
  meta: StoreMeta;
  /** The world's current `settings` documents — the grant ops are built against them. */
  settings: Iterable<unknown>;
  /** The world's current `users` documents, so an existing agent is reused, not duplicated. */
  users?: Iterable<unknown>;
  /** Plain name; `(agent)` is appended for the user document. */
  name: string;
  preset: AgentPreset;
  /** Unticking boxes: intersected with the preset, never a superset of it (§3.1). */
  capabilities?: readonly AgentCapability[];
  /** `"only scene Goblinwood"`, or null for the whole world. */
  sceneScope?: string | null;
  /** The MCP client that connected, for the GM's list. */
  client?: string | null;
  /** Default `active`; a first connection the GM has not approved yet is `pending`. */
  status?: AgentStatus;
  /** Seq to stamp `since` with; 0 when the caller does not care. */
  seq?: number;
}

export interface AgentSession {
  id: string;
  user: UserDocument;
  /** The agent's own replica — projected by the host for the agent's role (§5). */
  client: ClientSync;
  record: AgentRecord;
  /**
   * Drop the session. The **grant is untouched** — revoking is an edit to a replicated document
   * (`revokeAgentOps`) and undoing a revoke is one Ctrl+Z, which is the whole reason the grant is
   * a document at all.
   */
  dispose(): void;
}

export type OpenAgentSession =
  { ok: true; session: AgentSession; ops: Op[] } | { ok: false; error: string };

/**
 * Mint the user and the grant, then open the session. The two documents go out in **one system
 * envelope**: a world with a grant for a user that does not exist is a Settings window showing a
 * row it cannot explain.
 */
export function openAgentSession(
  options: OpenAgentSessionOptions,
): OpenAgentSession {
  const id = agentIdFor(options.name);
  const user = agentUserDoc({
    id,
    name: options.name,
    preset: options.preset,
    client: options.client ?? null,
  });
  const record: AgentRecord = {
    id,
    name: user.name,
    preset: options.preset,
    capabilities: capabilitiesFor(options.preset, options.capabilities),
    sceneScope: options.sceneScope ?? null,
    status: options.status ?? "active",
    auditNote: false,
    client: options.client ?? null,
    since: options.seq ?? 0,
  };

  const docs = [...(options.settings ?? [])];
  const known = [...(options.users ?? [])].some(
    (u) => (u as { _id?: unknown } | null)?._id === id,
  );
  const ops: Op[] = [
    ...(known
      ? []
      : [{ kind: "create" as const, coll: "users" as const, data: user }]),
    ...upsertAgentOps(docs, record),
  ];
  const committed = options.host.commitSystem(ops);
  if (!committed.ok) return { ok: false, error: committed.error };

  const pair = createTransportPair();
  options.host.addSession(id, pair.a, {
    id: user._id,
    role: user.role,
    name: user.name,
  });
  const client = new ClientSync({
    transport: pair.b,
    bus: createEventBus(),
    meta: options.meta,
  });

  return {
    ok: true,
    ops,
    session: {
      id,
      user,
      client,
      record,
      dispose: () => options.host.removeSession(id, "agent disconnected"),
    },
  };
}
