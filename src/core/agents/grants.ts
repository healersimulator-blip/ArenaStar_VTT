/**
 * MCP connector §3.2 — the grant is a **document**, not a preference.
 *
 * Three things follow from putting it in the replicated `settings` collection (`_id = "agents"`),
 * the same posture `worldSettings.ts` takes:
 *
 * - it survives a reload, so a GM does not re-approve an agent every session;
 * - it is visible to every replica, so a world file records what was *allowed*, not just what
 *   happened (§7.4: reversibility, and the audit a GM needs after the fact);
 * - it is undo-able like any other edit — a grant changed by accident is one Ctrl+Z away.
 *
 * This module is pure: it reads a document bag and returns `Op[]`. It never submits, so the
 * app's write path stays the only way anything changes, and these functions are testable with a
 * handful of plain objects.
 */
import type { Json, SettingsDocument } from "../documents";
import type { Op } from "../ops";
import {
  AGENT_CAPABILITIES,
  PRESETS,
  PRESET_ROLE,
  type AgentCapability,
  type AgentGrant,
  type AgentPreset,
} from "./capabilities";

export const AGENT_GRANTS_ID = "agents";
export const AGENT_GRANTS_NAME = "Agent grants";

/**
 * `pending` is the state a connected-but-unapproved agent sits in — the same state a joining human
 * sits in (§3.2), and the reason it is a status and not the absence of a record: an agent with no
 * grant at all and an agent the GM has not got round to approving look identical to the bridge.
 */
export type AgentStatus = "pending" | "active" | "revoked";

export interface AgentRecord {
  /** The agent's **user id** — the same id the OpLog stamps `by` with. */
  id: string;
  /** Display name, always suffixed `(agent)` so chat and the turn tracker label it honestly. */
  name: string;
  preset: AgentPreset;
  /** The capabilities the GM left ticked. Never a superset of the preset's (§3.1). */
  capabilities: AgentCapability[];
  /** `"only scene Goblinwood"`, or `null` for the whole world. */
  sceneScope: string | null;
  status: AgentStatus;
  /** §6.4 — post a GM-only chat card for every write this agent makes. */
  auditNote: boolean;
  /** The client that connected ("claude-desktop"), for the GM's list and for nothing else. */
  client: string | null;
  /** Seq of the envelope that last changed this record. */
  since: number;
}

const asRecord = (v: unknown): Record<string, unknown> | null =>
  typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;

const isSettingsDoc = (doc: unknown): boolean =>
  asRecord(doc)?.type === "settings";

const isCapability = (v: unknown): v is AgentCapability =>
  typeof v === "string" &&
  (AGENT_CAPABILITIES as readonly string[]).includes(v);

const isPreset = (v: unknown): v is AgentPreset =>
  v === "gm" || v === "gm-no-delete" || v === "player" || v === "observer";

const isStatus = (v: unknown): v is AgentStatus =>
  v === "pending" || v === "active" || v === "revoked";

const str = (v: unknown, fallback = ""): string =>
  typeof v === "string" ? v : fallback;

/**
 * Tolerate anything on the wire: a half-written grant from a future version must not take the
 * connector (or the Settings window) down with it. Unknown capabilities and unknown presets are
 * dropped; a record with no usable id is not a record.
 */
function recordFrom(raw: unknown): AgentRecord | null {
  const r = asRecord(raw);
  if (!r) return null;
  const id = str(r["id"]);
  if (!id) return null;
  const preset = isPreset(r["preset"]) ? r["preset"] : "observer";
  const picked = Array.isArray(r["capabilities"])
    ? r["capabilities"].filter(isCapability)
    : [];
  return {
    id,
    name: str(r["name"], id),
    preset,
    // A stored capability set is intersected with the preset on the way in *and* on the way out:
    // presets can shrink between versions, and a grant must never be wider than its preset.
    capabilities: capabilitiesFor(preset, picked),
    sceneScope: typeof r["sceneScope"] === "string" ? r["sceneScope"] : null,
    status: isStatus(r["status"]) ? r["status"] : "pending",
    auditNote: r["auditNote"] === true,
    client: typeof r["client"] === "string" ? r["client"] : null,
    since:
      typeof r["since"] === "number" && Number.isFinite(r["since"])
        ? r["since"]
        : 0,
  };
}

/** §3.1: the grant narrows the preset; it never widens it. */
export function capabilitiesFor(
  preset: AgentPreset,
  picked?: readonly AgentCapability[],
): AgentCapability[] {
  const allowed = PRESETS[preset];
  if (!picked) return [...allowed];
  return allowed.filter((c) => picked.includes(c));
}

/** The registry: every agent this world has ever granted anything to, including revoked ones. */
export interface AgentRegistry {
  agents: AgentRecord[];
}

/** Read the registry out of the world's `settings` documents. */
export function agentRegistryFrom(docs: Iterable<unknown>): AgentRegistry {
  for (const doc of docs) {
    if (!isSettingsDoc(doc)) continue;
    const r = asRecord(doc);
    if (r?._id !== AGENT_GRANTS_ID) continue;
    const raw = asRecord(r["system"])?.["grants"];
    if (!Array.isArray(raw)) continue;
    const agents = raw
      .map(recordFrom)
      .filter((a): a is AgentRecord => a !== null);
    return { agents };
  }
  return { agents: [] };
}

export function agentRecordOf(
  registry: AgentRegistry,
  id: string,
): AgentRecord | null {
  return registry.agents.find((a) => a.id === id) ?? null;
}

/**
 * The grant the bridge enforces. Two rules, both of which a capability list alone would let you
 * get wrong: a **pending or revoked agent has nothing** (not "the preset's defaults" — an agent
 * that connects before the GM has looked at it must not be able to read the world), and the role
 * comes from the preset, so the capabilities the GM ticks can never outrank it (§3.1).
 */
export function grantOfRecord(record: AgentRecord | null): AgentGrant {
  if (!record || record.status !== "active") {
    return {
      role: record ? PRESET_ROLE[record.preset] : "PLAYER",
      preset: record?.preset ?? "observer",
      capabilities: [],
    };
  }
  return {
    role: PRESET_ROLE[record.preset],
    preset: record.preset,
    capabilities: capabilitiesFor(record.preset, record.capabilities),
  };
}

const agentDoc = (agents: AgentRecord[]): SettingsDocument => ({
  _id: AGENT_GRANTS_ID,
  type: "settings",
  name: AGENT_GRANTS_NAME,
  // LIMITED, exactly like `worldSettingsDoc`: every replica is allowed to see **what is
  // allowed**, while `can()` still requires OWNER (or GM/ASSISTANT) to change it.
  ownership: { default: 1 },
  flags: {},
  system: { grants: agents as unknown as Json },
});

const canonicalDoc = (
  docs: Iterable<unknown>,
): Record<string, unknown> | null => {
  for (const doc of docs) {
    if (!isSettingsDoc(doc)) continue;
    const r = asRecord(doc);
    if (r?._id === AGENT_GRANTS_ID) return r;
  }
  return null;
};

/**
 * Add or replace one agent's record. The whole `grants` array is rewritten (it is a handful of
 * small objects and the alternative — index paths — is how a concurrent edit silently lands on
 * the wrong row), and a revoked record is kept: the world file remembering what was allowed is
 * the point (§7.4).
 */
export function upsertAgentOps(
  docs: Iterable<unknown>,
  record: AgentRecord,
): Op[] {
  const canonical = canonicalDoc(docs);
  const registry = agentRegistryFrom(docs);
  const rest = registry.agents.filter((a) => a.id !== record.id);
  const next = [...rest, record].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  if (!canonical)
    return [{ kind: "create", coll: "settings", data: agentDoc(next) }];
  return [
    {
      kind: "update",
      ref: { coll: "settings", id: AGENT_GRANTS_ID },
      diff: { "system.grants": next as unknown as Json },
    },
  ];
}

/** Revoke: the record stays, the capabilities go, and the audit keeps the shape of what happened. */
export function revokeAgentOps(docs: Iterable<unknown>, id: string): Op[] {
  const record = agentRecordOf(agentRegistryFrom(docs), id);
  if (!record) return [];
  return upsertAgentOps(docs, {
    ...record,
    status: "revoked",
    capabilities: [],
  });
}

/** Forget an agent entirely — the GM's "remove from the list", not the same act as revoking. */
export function forgetAgentOps(docs: Iterable<unknown>, id: string): Op[] {
  const canonical = canonicalDoc(docs);
  if (!canonical) return [];
  const registry = agentRegistryFrom(docs);
  const next = registry.agents.filter((a) => a.id !== id);
  if (next.length === registry.agents.length) return [];
  return [
    {
      kind: "update",
      ref: { coll: "settings", id: AGENT_GRANTS_ID },
      diff: { "system.grants": next as unknown as Json },
    },
  ];
}

/** The document the very first grant creates, exposed so the UI can show what it is about to add. */
export const agentGrantDocument = agentDoc;
