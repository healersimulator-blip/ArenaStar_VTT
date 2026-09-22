/**
 * MCP connector §6 — the app's half of the bridge: what the *world* looks like to a tool, and how
 * the GM's tab dials the sidecar.
 *
 * The protocol and the tool table live in `src/core/agents`; this file is only the wiring, and it is
 * deliberately thin. Two things are true of it in Phase 0 and worth stating out loud:
 *
 * 1. **Reads are the GM's replica, not a projection.** A tool that reads the world today reads the
 *    store this tab holds. That is correct for a GM-scoped agent and wrong for a player-scoped one,
 *    which is exactly the gap Phase 3 closes by routing reads through `projectWorld()` for the
 *    agent's user and proving it field-by-field. Nothing here pretends otherwise.
 * 2. **There is no UI yet.** `connectAgentBridge` is a function, not a window: the Agents section in
 *    Settings (Phase 2) is the production entry point, and until it exists the only caller is the
 *    e2e surface, which is how the repo already drives things it does not want reachable from a
 *    page console (D-045). A connector whose identity is the whole design does not get a global.
 */
import type { ClientSync } from "../client/sync";
import type { AgentGrant } from "../core/agents/capabilities";
import { createAgentBridge, type AgentBridge } from "../core/agents/bridge";
import type {
  AgentIdentity,
  AgentWorldInfo,
  AgentWorldView,
} from "../core/agents/tools";
import { TOP_LEVEL_COLLECTIONS } from "../core/documents";
import { createAgentLink, type AgentLinkStatus } from "../net/agentLink";

/**
 * The world as this tab holds it. Counts are non-empty collections only: an agent that asks what
 * the world *is* wants to know it has 3 scenes and 41 actors, not that it has zero depots.
 */
export function agentWorldView(client: ClientSync): AgentWorldView {
  return {
    worldInfo(): AgentWorldInfo {
      const meta = client.store.meta;
      const collections: Record<string, number> = {};
      for (const coll of TOP_LEVEL_COLLECTIONS) {
        const count = client.store.getAll(coll).length;
        if (count > 0) collections[coll] = count;
      }
      return {
        id: meta.worldId,
        name: meta.name,
        system: meta.system,
        version: meta.systemVersion,
        seq: client.store.seq,
        collections,
      };
    },
    identity(): AgentIdentity | null {
      const me = client.user;
      return me ? { id: me.id, name: me.name, role: me.role } : null;
    },
  };
}

/** The connect URL, with the pairing token in the query the sidecar checks on upgrade. */
export function agentLinkUrl(base: string, token: string): string {
  const url = new URL(base);
  if (url.pathname === "/") url.pathname = "/bridge";
  url.searchParams.set("token", token);
  return url.toString();
}

export interface ConnectAgentBridgeOptions {
  /** e.g. `ws://127.0.0.1:8787` — the sidecar prints this when it starts. */
  url: string;
  /** The one-time pairing token the sidecar printed. */
  token: string;
  client: ClientSync;
  grant: AgentGrant;
  onStatus?: (status: AgentLinkStatus) => void;
}

export function connectAgentBridge(
  options: ConnectAgentBridgeOptions,
): AgentBridge {
  const { url, token, client, grant, onStatus } = options;
  const transport = createAgentLink(
    onStatus === undefined
      ? { url: agentLinkUrl(url, token) }
      : { url: agentLinkUrl(url, token), onStatus },
  );
  return createAgentBridge({ transport, view: agentWorldView(client), grant });
}
