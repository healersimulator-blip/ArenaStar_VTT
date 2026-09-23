/**
 * MCP connector §4 — the capability vocabulary an agent grant is made of.
 *
 * The whole design rests on one sentence from §3.1: **the host remains the only authority.** The
 * host validates every `Intent` an agent submits exactly as it validates a human's, so a bug in the
 * bridge cannot hand a player-scoped agent a GM write. This module is therefore *not* the security
 * boundary — it is the UX of the boundary plus defence in depth:
 *
 * - a **capability** is one verb class the GM may withhold (`doc.delete`, `gmOnly.read`, …);
 * - a **preset** is a starting bundle of them (§3.1's four kinds of agent);
 * - a **grant** is a preset plus a role, and `allows()` is the single place that decides.
 *
 * Every tool declares the one capability it needs, and a refusal carries the reason in plain words
 * (§4) — "this agent may not delete documents — ask the GM to change its grant" — because an LLM
 * that is told *why* a door is closed stops pushing on it, and one that is told only "error" does not.
 *
 * Pure and DOM-free: it is unit-tested in `tests/core/agentsCapabilities.test.ts`.
 */
import type { Role } from "../documents";
import { err, ok, type OkOrErr } from "../result";

export type AgentCapability =
  | "world.read"
  | "gmOnly.read"
  | "chat.read"
  | "chat.speak"
  | "chat.whisper"
  | "doc.create"
  | "doc.update"
  | "doc.delete"
  | "token.move"
  | "token.properties"
  | "scene.manage"
  | "scene.activate"
  | "fog.control"
  | "fog.reveal"
  | "time.control"
  | "dice.roll"
  | "dice.apply"
  | "combat.control"
  | "strategic.read"
  | "strategic.order"
  | "hexcrawl.read"
  | "hexcrawl.travel"
  /** Authoring the overworld: cells, their hidden features, the tables, the profile. */
  | "hexcrawl.author"
  | "assets.write"
  | "undo";

export const AGENT_CAPABILITIES: readonly AgentCapability[] = [
  "world.read",
  "gmOnly.read",
  "chat.read",
  "chat.speak",
  "chat.whisper",
  "doc.create",
  "doc.update",
  "doc.delete",
  "token.move",
  "token.properties",
  "scene.manage",
  "scene.activate",
  "fog.control",
  "fog.reveal",
  "time.control",
  "dice.roll",
  "dice.apply",
  "combat.control",
  "strategic.read",
  "strategic.order",
  "hexcrawl.read",
  "hexcrawl.travel",
  "hexcrawl.author",
  "assets.write",
  "undo",
];

export type AgentPreset = "gm" | "gm-no-delete" | "player" | "observer";

export const AGENT_PRESETS: readonly AgentPreset[] = [
  "gm",
  "gm-no-delete",
  "player",
  "observer",
];

/** §3.1: the role each kind of agent sits in. The grant narrows the role; it never widens it. */
export const PRESET_ROLE: Record<AgentPreset, Role> = {
  gm: "GM",
  "gm-no-delete": "ASSISTANT",
  player: "PLAYER",
  observer: "PLAYER",
};

const without = (...drop: AgentCapability[]): readonly AgentCapability[] =>
  AGENT_CAPABILITIES.filter((c) => !drop.includes(c));

/**
 * §4's `PRESETS`. `player` is deliberately thin: it reads its own projection — the world **and the
 * hexcrawl map the party has revealed** — speaks and rolls, and moves the tokens it owns.
 * Ownership, not the mask, is what stops it touching anyone else's, and that is the host's `can()`
 * doing the work (proved field-by-field in Phase 3).
 *
 * It does **not** hold `hexcrawl.travel`: a march spends the table's clock and moves the party
 * token every player shares, so walking is the GM's call unless the GM narrows a grant to say
 * otherwise. Reading where the party is and what the ground costs is not.
 */
export const PRESETS: Record<AgentPreset, readonly AgentCapability[]> = {
  gm: AGENT_CAPABILITIES,
  "gm-no-delete": without("doc.delete"),
  player: [
    "world.read",
    "hexcrawl.read",
    "chat.read",
    "chat.speak",
    "chat.whisper",
    "dice.roll",
    "token.move",
    "undo",
  ],
  observer: ["world.read", "hexcrawl.read", "chat.read"],
};

/** What a capability lets an agent do, in the words a refusal should use. */
const PHRASE: Record<AgentCapability, string> = {
  "world.read": "read the world",
  "gmOnly.read": "read the GM's own data",
  "chat.read": "read the chat",
  "chat.speak": "post to the chat",
  "chat.whisper": "whisper",
  "doc.create": "create documents",
  "doc.update": "edit documents",
  "doc.delete": "delete documents",
  "token.move": "move tokens",
  "token.properties": "change a token's properties",
  "scene.manage": "manage scenes",
  "scene.activate": "change the active scene",
  "fog.control": "control fog",
  "fog.reveal": "reveal fog",
  "time.control": "move the clock",
  "dice.roll": "roll dice",
  "dice.apply": "apply a roll's damage",
  "combat.control": "run combat",
  "strategic.read": "read the strategic layer",
  "strategic.order": "issue strategic orders",
  "hexcrawl.read": "read the hexcrawl",
  "hexcrawl.travel": "move the party",
  "hexcrawl.author": "author the overworld",
  "assets.write": "upload images",
  undo: "undo",
};

export interface AgentGrant {
  /** The role the agent's session holds — the ceiling the mask may only narrow. */
  role: Role;
  preset: AgentPreset;
  capabilities: readonly AgentCapability[];
}

export function grantFor(preset: AgentPreset): AgentGrant {
  return { role: PRESET_ROLE[preset], preset, capabilities: PRESETS[preset] };
}

/** A grant narrowed further by hand (the GM unticking boxes in Phase 2's window). */
export function narrow(
  grant: AgentGrant,
  capabilities: readonly AgentCapability[],
): AgentGrant {
  return { ...grant, capabilities };
}

/**
 * The gate. A `null` capability is a tool that needs nothing (the identity probe) and is always
 * allowed — an agent that cannot ask who it is cannot route around any other refusal.
 */
/**
 * May this grant read the GM's own data — hidden tokens, secret text, blind rolls? Reads and
 * writes share the predicate: an agent that cannot *see* a hidden token must not be able to move
 * it either.
 */
export const canReadGmOnly = (grant: AgentGrant): boolean =>
  allows(grant, "gmOnly.read").ok;

/** §4's plain words, in one place: the gate and the tests must never disagree on the sentence. */
export function refusalFor(capability: AgentCapability): string {
  return `this agent may not ${PHRASE[capability]} — ask the GM to change its grant`;
}

export function allows(
  grant: AgentGrant,
  capability: AgentCapability | null,
): OkOrErr {
  if (capability === null) return ok;
  if (grant.capabilities.includes(capability)) return ok;
  return err(refusalFor(capability));
}
