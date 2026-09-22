/**
 * MCP connector §3.2 + §6 — the app's agent desk: who is connected, what they may do, and what they
 * did.
 *
 * This is the piece the Settings window talks to, and it exists so the UI never holds transport
 * handles, sessions or grants in component state. Three rules:
 *
 * - **The grant is a document; the session is not.** Changing a grant writes to the replicated
 *   `settings` document (undoable, visible to every replica); opening or dropping a session is
 *   runtime state that a reload simply rebuilds.
 * - **Revoke is not delete.** Revoking empties the capabilities and closes the session, and the
 *   record stays — the world file remembers what was allowed, which is the audit a GM reads after
 *   the fact (§7.4). "Forget" is a separate, explicit act.
 * - **A session opened twice is the same agent.** The id is derived from the name, so a reload
 *   reconnects the same user and the same grant instead of accumulating rows.
 */
import type { ClientSync } from "../client/sync";
import type { HostSync } from "../host/sync";
import type { StoreMeta } from "../core/store";
import type { Op } from "../core/ops";
import type { AgentCapability, AgentPreset } from "../core/agents/capabilities";
import { capabilitiesFor } from "../core/agents/grants";
import {
  agentRegistryFrom,
  agentRecordOf,
  forgetAgentOps,
  revokeAgentOps,
  upsertAgentOps,
  type AgentRecord,
} from "../core/agents/grants";
import { connectAgentBridge } from "./agentBridge";
import { openAgentSession, type AgentSession } from "./agentSession";
import type { AgentBridge, AgentAuditEntry } from "../core/agents/bridge";
import { grantOfRecord } from "../core/agents/grants";

export interface AgentHandle {
  record: AgentRecord;
  /** Null while the agent is granted but not connected (a reload, or a revoked session). */
  session: AgentSession | null;
  bridge: AgentBridge | null;
}

export interface AgentManagerOptions {
  host: HostSync;
  /** The GM's client — the grant edits travel through it, so they are undoable like any edit. */
  client: ClientSync;
  meta: StoreMeta;
}

export interface AgentManager {
  /** Every agent this world has a record for, newest last, including revoked ones. */
  list(): AgentHandle[];
  recordOf(id: string): AgentRecord | null;
  /** Mint the user + the grant, and open the session. Idempotent by name. */
  add(
    name: string,
    preset: AgentPreset,
    capabilities?: readonly AgentCapability[],
  ): AgentHandle | null;
  /** Narrow the grant. Never widens it: the intersection with the preset is taken again (§3.1). */
  setGrant(
    id: string,
    patch: {
      preset?: AgentPreset;
      capabilities?: readonly AgentCapability[];
      sceneScope?: string | null;
      auditNote?: boolean;
      status?: AgentRecord["status"];
    },
  ): void;
  /** Revoke: the capabilities go, the session closes, the record stays. */
  revoke(id: string): void;
  /** Forget: the record goes too. The GM's "remove from the list", not the same act as revoking. */
  forget(id: string): void;
  /**
   * Connect (or reconnect) an agent's bridge to a sidecar. Phase 2 has no discovery UI, so the
   * URL and the pairing token come from the caller — the Settings field, or a test.
   */
  connect(id: string, url: string, token: string): boolean;
  disconnect(id: string): void;
  /** The audit rings of every connected agent, newest last (§6.4: the GM's record of attempts). */
  audit(limit?: number): AgentAuditEntry[];
  dispose(): void;
}

export function createAgentManager(options: AgentManagerOptions): AgentManager {
  const { host, client, meta } = options;
  const sessions = new Map<string, AgentSession>();
  const bridges = new Map<string, AgentBridge>();
  /**
   * The record this manager last wrote, per agent. A commit lands on the host's store synchronously
   * and on this replica one tick later, so "add an agent and connect it in the same handler" would
   * otherwise read a world with no grant in it. The document remains the truth every replica shares;
   * this is the manager's own copy of what it just did, used only until the replica catches up.
   */
  const lastRecord = new Map<string, AgentRecord>();
  /**
   * The last URL/token each agent was connected with, so a grant edit can rebuild the bridge in
   * place without asking the GM to paste the pairing token again. Deliberately **not** persisted
   * anywhere: it is a loopback address to a process this tab started, and a stale one is worse
   * than none.
   */
  const lastUrl = new Map<string, string>();
  const lastToken = new Map<string, string>();

  const settingsDocs = (): unknown[] => [...client.store.getAll("settings")];

  const list = (): AgentHandle[] =>
    agentRegistryFrom(settingsDocs()).agents.map((record) => ({
      record,
      session: sessions.get(record.id) ?? null,
      bridge: bridges.get(record.id) ?? null,
    }));

  const submit = (ops: readonly Op[]): void => {
    if (ops.length === 0) return;
    client.submit([...ops]);
  };

  return {
    list,

    recordOf(id) {
      return (
        lastRecord.get(id) ??
        agentRecordOf(agentRegistryFrom(settingsDocs()), id)
      );
    },

    add(name, preset, capabilities) {
      const opened = openAgentSession({
        host,
        meta,
        settings: settingsDocs(),
        users: client.store.getAll("users"),
        name,
        preset,
        ...(capabilities ? { capabilities } : {}),
      });
      if (!opened.ok) return null;
      sessions.set(opened.session.id, opened.session);
      lastRecord.set(opened.session.id, opened.session.record);
      return {
        record: opened.session.record,
        session: opened.session,
        bridge: bridges.get(opened.session.id) ?? null,
      };
    },

    setGrant(id, patch) {
      const current = agentRecordOf(agentRegistryFrom(settingsDocs()), id);
      if (!current) return;
      const preset = patch.preset ?? current.preset;
      const next: AgentRecord = {
        ...current,
        preset,
        // A preset change re-intersects the ticks: the boxes the GM left ticked in the old preset
        // are not a promise about the new one.
        capabilities: capabilitiesFor(
          preset,
          patch.capabilities ?? current.capabilities,
        ),
        sceneScope:
          patch.sceneScope === undefined
            ? current.sceneScope
            : patch.sceneScope,
        auditNote: patch.auditNote ?? current.auditNote,
        status: patch.status ?? current.status,
        since: client.store.seq,
      };
      lastRecord.set(id, next);
      submit(upsertAgentOps(settingsDocs(), next));
      // A live session's capability mask is the grant, so it has to be rebuilt in place: the next
      // call is refused by the new grant, not the one that was true when the socket opened.
      const session = sessions.get(id);
      const bridge = bridges.get(id);
      if (session && bridge && next.status === "active") {
        bridge.dispose();
        const url = lastUrl.get(id);
        const token = lastToken.get(id);
        if (url !== undefined && token !== undefined) {
          bridges.set(
            id,
            connectAgentBridge({
              url,
              token,
              client: session.client,
              grant: grantOfRecord(next),
              writer: session.writer,
              agentId: id,
            }),
          );
        } else {
          bridges.delete(id);
        }
      }
      if (next.status !== "active") this.disconnect(id);
    },

    revoke(id) {
      const current = this.recordOf(id);
      if (current)
        lastRecord.set(id, { ...current, status: "revoked", capabilities: [] });
      submit(revokeAgentOps(settingsDocs(), id));
      this.disconnect(id);
    },

    forget(id) {
      this.disconnect(id);
      lastRecord.delete(id);
      submit(forgetAgentOps(settingsDocs(), id));
    },

    connect(id, url, token) {
      const session = sessions.get(id);
      if (!session) return false;
      const record = this.recordOf(id);
      if (!record || record.status !== "active") return false;
      lastUrl.set(id, url);
      lastToken.set(id, token);
      bridges.get(id)?.dispose();
      bridges.set(
        id,
        connectAgentBridge({
          url,
          token,
          client: session.client,
          grant: grantOfRecord(record),
          writer: session.writer,
          agentId: id,
        }),
      );
      return true;
    },

    disconnect(id) {
      bridges.get(id)?.dispose();
      bridges.delete(id);
      sessions.get(id)?.dispose();
      sessions.delete(id);
      lastUrl.delete(id);
      lastToken.delete(id);
      // The record is deliberately kept: disconnecting is not revoking.
    },

    audit(limit = 50) {
      const entries: AgentAuditEntry[] = [];
      for (const bridge of bridges.values()) entries.push(...bridge.audit());
      entries.sort((a, b) => a.at - b.at);
      return entries.slice(-limit);
    },

    dispose() {
      for (const bridge of bridges.values()) bridge.dispose();
      bridges.clear();
      for (const session of sessions.values()) session.dispose();
      sessions.clear();
    },
  };
}
