/**
 * MCP connector §5 — the shapes the tool catalogue is built from.
 *
 * Split out of `tools.ts` so the tool modules (`baseTools`, `readTools`, and the write tools to come)
 * can each import the types without importing one another: **one registry, assembled once**, in
 * `tools.ts`, and no cycles between the modules that contribute to it.
 */
import type { Json, Role } from "../documents";
import type { AgentCapability, AgentGrant } from "./capabilities";

export type { AgentCapability, AgentGrant };

/** The world, as this agent's user is allowed to read it (§6: reads are the projection). */
export interface AgentWorldView {
  worldInfo(): AgentWorldInfo;
  snapshot(): AgentSnapshot;
  /** Null before the session has been welcomed — an agent may connect before its grant lands. */
  identity(): AgentIdentity | null;
  /** One integral clock, in seconds (§5.5): the same ladder combat, effects and travel spend. */
  clockSeconds(): number;
  /** The scenes this replica holds, active first. */
  scenes(): AgentSceneSummary[];
  /** One scene with its geometry and contents; null when the id is not one this agent may see. */
  scene(id: string | null): AgentSceneDetail | null;
  tokens(sceneId: string | null, options: PageOptions): Page<AgentTokenRow>;
  documents(coll: string, options: PageOptions): Page<AgentDocumentRow>;
  /** One document, whole — the view redacts it (the app reads through the projection). */
  document(coll: string, id: string): AgentDocument | null;
  messages(options: PageOptions & { since?: number }): Page<AgentMessageRow>;
  sheet(actorId: string): AgentSheet | null;
  /** Optional: only a replica with the compendium runtime can answer it. */
  bestiary?(query: string, limit: number): Promise<AgentBestiaryHit[]>;
  packages?(): AgentPackageRow[];
}

export interface AgentWorldInfo {
  id: string;
  name: string;
  system: string;
  version: string;
  /** The replica's sequence number: what the agent just read is true as of here. */
  seq: number;
  /** Non-empty collections only — a world is mostly empty, and empty rows are noise. */
  collections: Record<string, number>;
}

/** §5.1's cheap "what has changed" poll: counts and the seq, nothing else. */
export interface AgentSnapshot {
  seq: number;
  collections: Record<string, number>;
}

export interface AgentIdentity {
  id: string;
  name: string;
  role: Role;
}

export interface PageOptions {
  limit?: unknown;
  cursor?: unknown;
}

export interface AgentSceneSummary {
  id: string;
  name: string;
  active: boolean;
  width: number;
  height: number;
  grid: {
    type: string;
    size: number;
    distance: number;
    units: string;
    hexLayout: string;
  };
  darkness: number;
  tokens: number;
  walls: number;
  /** Null when this replica holds no fog configuration. */
  fog: { enabled: boolean; mode: string } | null;
}

export interface AgentTokenRow {
  id: string;
  name: string;
  x: number;
  y: number;
  col: number;
  row: number;
  disposition: "hostile" | "neutral" | "friendly";
  hidden: boolean;
  actorId: string | null;
}

/** One scene with its contents. `walls` are the segments themselves, not the summary's count. */
export interface AgentSceneDetail extends Omit<AgentSceneSummary, "walls"> {
  tokenRows: AgentTokenRow[];
  walls: Array<{
    c: [number, number, number, number];
    door: number;
    move: number;
    sight: number;
  }>;
  /** Null when this replica holds no fog state — the renderer says so instead of guessing. */
  fogCells: { cols: number; rows: number; cells: Uint8Array } | null;
}

export interface AgentMessageRow {
  id: string;
  author: string;
  authorName: string;
  content: string;
  /** Empty = public. A whisper the agent is not in never reaches the view (§5 projection). */
  whisper: string[];
  hasRoll: boolean;
  /** null = no roll; the mode decides whether the *result* is the agent's to read. */
  rollMode: string | null;
}

export interface AgentDocumentRow {
  id: string;
  name: string;
  type: string;
  parent: string | null;
}

export interface AgentDocument {
  id: string;
  type: string;
  name: string;
  fields: Record<string, Json>;
}

/** §5.4's derived sheet, trimmed to what a model can act on — not the whole derivation. */
export interface AgentSheet {
  actorId: string;
  name: string;
  hp: { current: number; max: number; nonlethal: number };
  ac: { normal: number; touch: number; flatFooted: number };
  saves: { fort: number; ref: number; will: number };
  initiative: number;
  baseAttack: number;
  cmb: number;
  cmd: number;
  speedFt: number;
  conditions: string[];
  attacks: Array<{
    name: string;
    bonus: number;
    damage: string | null;
    ranged: boolean;
  }>;
  /** Only the skills the creature is trained in or that an effect moved — not all 40 rows. */
  skills: Array<{ name: string; bonus: number }>;
  feats: string[];
}

export interface AgentBestiaryHit {
  id: string;
  name: string;
  type: string;
  pack: string;
}

export interface AgentPackageRow {
  id: string;
  label: string;
  /** How many entries the pack's index carries — the number that makes 25k-entry packs visible. */
  entries: number;
}

export type ToolContent = { type: "text"; text: string };

/** MCP's tool result shape (§5): text blocks, an optional machine-readable body, an error flag. */
export interface ToolResult {
  content: ToolContent[];
  structuredContent?: Json;
  isError?: boolean;
}

export interface ToolContext {
  view: AgentWorldView;
  grant: AgentGrant;
}

/**
 * The argument shape, in the only subset this feature needs. Deliberately not a JSON-Schema
 * dependency (§9 risk 1: no SDK in the runtime path) — `inputSchemaOf()` renders the standard form
 * for `tools/list`, and `validateArgs()` enforces it on the way in.
 */
export interface ToolArgsSchema {
  properties: Record<
    string,
    {
      type: "string" | "number" | "integer" | "boolean" | "array" | "object";
      description: string;
    }
  >;
  required?: string[];
}

/**
 * What a tool answers. A `ToolResult` is a normal answer (including a refusal with `isError`);
 * `{ invalid }` is a **malformed call** — a bad cursor, an argument that is the right type but not a
 * usable value — which the bridge turns into JSON-RPC `-32602`. The distinction is the whole point:
 * "you may not delete" is information, "your cursor is not a cursor" is a client bug.
 */
export type ToolOutcome = ToolResult | { invalid: string };

export const invalidCall = (error: string): ToolOutcome => ({ invalid: error });

export const isInvalid = (
  outcome: ToolOutcome,
): outcome is { invalid: string } => !("content" in outcome);

export interface ToolDefinition {
  name: string;
  /** One sentence, addressed to the model: what it gets back, not how it works. */
  description: string;
  args: ToolArgsSchema;
  /** `null` = needs nothing (the identity probe must always be answerable). */
  capability: AgentCapability | null;
  run(
    args: Record<string, Json>,
    ctx: ToolContext,
  ): ToolOutcome | Promise<ToolOutcome>;
}

export interface Page<T> {
  rows: T[];
  total: number;
  next: string | null;
  cap: number;
}
