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
import {
  createEventBus,
  type EventBus,
  type Unsubscribe,
} from "../core/events";
import type { ClientEvents } from "../client/sync";
import type { RejectionReason } from "../core/messages";
import type {
  AgentSubmitResult,
  AgentUndoResult,
  AgentWriter,
} from "../core/agents/types";
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
   * The write port §6.2: one call builds one `Op[]`, this submits it as one envelope and waits
   * for the host's verdict.
   */
  writer: AgentWriter;
  /**
   * Drop the session. The **grant is untouched** — revoking is an edit to a replicated document
   * (`revokeAgentOps`) and undoing a revoke is one Ctrl+Z, which is the whole reason the grant is
   * a document at all.
   */
  dispose(): void;
}

/**
 * The app's implementation of §6.2's write port: submit, then **wait for the host's verdict**.
 *
 * The wait is the honest part. `ClientSync.submit` returns a `txId` and moves on — the host may
 * still refuse the envelope (permissions, invariants, rate limits), and a tool that answered
 * "done" at submit time would be lying about the world. So this resolves on the first of: the
 * envelope coming back with this txId reconciled (`ok`), a `rejected` message for it (the host's
 * own reason, passed through verbatim), or the timeout.
 *
 * The timeout is a refusal, not a hang: an MCP client waiting on an id nobody answers is the
 * worst failure this shape has (Phase 0's `-32603` when no tab is paired is the same judgement
 * one layer up).
 */
const SUBMIT_TIMEOUT_MS = 5_000;

export function agentWriter(
  client: ClientSync,
  bus: EventBus<ClientEvents>,
  host: HostSync,
  userId: string,
): AgentWriter {
  return {
    submit(ops: Op[]): Promise<AgentSubmitResult> {
      const txId = client.submit(ops);
      return new Promise<AgentSubmitResult>((resolve) => {
        let offOps: Unsubscribe | null = null;
        let offRejected: Unsubscribe | null = null;
        const done = (result: AgentSubmitResult): void => {
          if (timer !== null) clearTimeout(timer);
          offOps?.();
          offRejected?.();
          resolve(result);
        };
        const timer = setTimeout(
          () =>
            done({
              ok: false,
              reason: "timeout",
              error: `the host did not answer within ${SUBMIT_TIMEOUT_MS} ms`,
            }),
          SUBMIT_TIMEOUT_MS,
        );
        offOps = bus.on("ops", ({ envelope, reconciled }) => {
          if (reconciled !== txId) return;
          done({ ok: true, seq: envelope.seq, txId });
        });
        offRejected = bus.on("rejected", ({ txId: id, reason, detail }) => {
          if (id !== txId) return;
          done({ ok: false, reason: reason as RejectionReason, error: detail });
        });
      });
    },
    async undoOwn(): Promise<AgentUndoResult> {
      const done = host.undoOwn({ id: userId, role: "GM", name: userId });
      return done.ok
        ? { ok: true, what: done.what ?? "your last change" }
        : { ok: false, error: done.error ?? "nothing to undo" };
    },
  };
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
  const bus = createEventBus<ClientEvents>();
  const client = new ClientSync({
    transport: pair.b,
    bus,
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
      writer: agentWriter(client, bus, options.host, user._id),
      dispose: () => options.host.removeSession(id, "agent disconnected"),
    },
  };
}
