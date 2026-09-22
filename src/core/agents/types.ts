/**
 * MCP connector §5 — the shapes the tool catalogue is built from.
 *
 * Split out of `tools.ts` so the tool modules (`baseTools`, `readTools`, and the write tools to come)
 * can each import the types without importing one another: **one registry, assembled once**, in
 * `tools.ts`, and no cycles between the modules that contribute to it.
 */
import type { Json, Role } from "../documents";
import type { Op } from "../ops";
import type { HexGlyph, HexMapOptions } from "./hexRender";
import type { RejectionReason } from "../messages";
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
  /** The hexcrawl layer of a scene: a summary, its cells, one cell, and a rendered map. */
  hexSummary(sceneId: string | null): AgentHexSummary | null;
  hexCells(sceneId: string | null, options: PageOptions): Page<AgentHexCell>;
  hexCell(sceneId: string | null, key: string): AgentHexCell | null;
  hexMap(
    sceneId: string | null,
    options: { around?: string | null; radius?: number },
  ): AgentHexMapPlan | null;
  /** The party's route, when the scene has one. */
  hexTravel(sceneId: string | null): AgentTravelPlan | null;
  /** Commit a route (or, with an empty path, drop it). */
  travelPlanOps(
    sceneId: string | null,
    spec: { path: string[]; speedPerDay?: number; pace?: string },
  ): Op[] | { error: string };
  /** One march: the ops, and what they did. */
  travelAdvanceOps(
    sceneId: string | null,
    seconds: number,
  ): AgentTravelAdvance | { error: string };
  /** What the encounter engine says about a cell now — a check, not yet a placement. */
  encounterCheckOps(
    sceneId: string | null,
    spec: { cellKey?: string | null; trigger?: string },
  ): AgentEncounterCheck | { error: string };
  /** Put N of each named actor on the map, spiralling out from a cell. */
  encounterPlaceOps(
    sceneId: string | null,
    spec: {
      actors: Array<{ actorId: string; count: number }>;
      cellKey?: string | null;
      col?: number;
      row?: number;
    },
  ): Op[] | { error: string };
  /** The one clock, read against the ladder the rest of the world spends (§5.5). */
  clock(): AgentClock;
  /** Time passing: the clock ops **and** the effect sweep they trigger, as one bundle. */
  timeOps(spec: { delta?: number; seconds?: number }): AgentTimeOps | { error: string };
  /** The encounter on a scene, as the tracker shows it — null when there is none. */
  combatState(sceneId: string | null): AgentCombatState | null;
  /** Begin it: the transition, its clock delta, and the ops that carry both. */
  combatStartOps(
    sceneId: string | null,
    spec: {
      name?: string;
      initiative?: Record<string, number>;
      unaware?: string[];
    },
  ): AgentCombatTurn | { error: string };
  /** Add combatants to the encounter, creating it from the scene's tokens when there is none. */
  combatAddOps(
    sceneId: string | null,
    spec: {
      name?: string;
      combatants: Array<{
        tokenId?: string | null;
        actorId?: string | null;
        name?: string | null;
        initiative?: number | null;
      }>;
    },
  ): AgentCombatTurn | { error: string };
  /** Advance a turn (a round wrap moves the clock, when this world advances it). */
  combatNextOps(sceneId: string | null, count: number): AgentCombatTurn | { error: string };
  /** End it: the tracker stops and the round structure is cleared. */
  combatEndOps(sceneId: string | null): AgentCombatTurn | { error: string };
  /**
   * Roll dice **through the host** (§5.5). The formula travels; the number comes back from the
   * host's own dice, which is why this is async — and why an agent cannot claim a total.
   */
  diceRoll(spec: {
    formula: string;
    mode?: string;
    to?: string[];
    flavor?: string;
  }): Promise<AgentDiceRoll | { error: string }>;
  /**
   * Ask the host to apply a roll card's own total to an actor. No amount travels: the host reads
   * the card and decides, exactly as the chat card's *Apply* button does.
   */
  diceApply(spec: {
    messageId: string;
    actorId: string;
    mode: "damage" | "healing";
  }): Promise<AgentDiceApply | { error: string }>;
  /**
   * Optional: one compendium entry by id, in the shape its pack authors it. Only a replica with
   * the compendium runtime can answer it.
   */
  compendiumEntry?(id: string): Promise<AgentCompendiumEntry | null>;
  /**
   * Optional: the D-264/D-267 import front door — pasted text (a stat block, or a Foundry/Roll20/
   * Hero Lab export) becomes the ops that create the actor. The **importer's own sentence** comes
   * back as the error, because "a stat block starts with the creature's name and its CR" is what
   * tells an agent what to paste next time.
   */
  importCharacter?(
    text: string,
    options: { id: string },
  ): AgentImportPlan | { error: string };
  /**
   * Optional: the one create op that puts a token on a scene at a cell. The token's own shape
   * (D-061's tabletop default, the app's light/vision defaults) lives in the app layer, so the
   * view is the only place that can build it; core gets a cell and gets an op back.
   */
  tokenCreate?(spec: {
    sceneId: string;
    name: string;
    actorId?: string | null;
    col: number;
    row: number;
  }): Op | { error: string };
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
  /**
   * This session owns the token — directly, or by the scene above it (§4's ownership cascade).
   * `token.move` moves owned tokens for a grant that is not the GM's; the rest it names as not
   * the agent's to move. A GM/ASSISTANT session owns everything, because its role says so.
   */
  owned: boolean;
}

/** One feature of a cell, in the words the GM authored its rule in. */
export interface AgentHexFeature {
  id: string;
  name: string;
  /** Shown to the table yet? An unrevealed feature is simply not on a player's replica (D-271). */
  revealed: boolean;
  /** The rule, as the UI words it: "found after 1 hour", "found on a Perception check (DC 15)". */
  rule: string;
}

/** One authored cell of a hexcrawl scene — what this replica holds of it. */
export interface AgentHexCell {
  /** `q,r`. The id every other hexcrawl tool takes. */
  key: string;
  col: number;
  row: number;
  /** Terrain catalog id; null when the cell names none (the catalog's default covers it). */
  terrain: string | null;
  terrainName: string | null;
  /** Travel cost multiplier: 1 = open ground, 2 = half speed (§ the terrain catalog). */
  cost: number;
  /** Revealed to the table. A closed cell is absent from a player's replica, not flagged on it. */
  open: boolean;
  /** The GM's text — never present on a player's replica. */
  description: string | null;
  /** What the table reads once the cell is open. */
  playerText: string | null;
  /** Encounter table ids bound to this cell. */
  tables: string[];
  features: AgentHexFeature[];
  /** Seconds the party has spent here — the clock a "found after N hours" rule measures. */
  exploredSeconds: number;
}

/** The hexcrawl layer of one scene, before any single cell is read. */
/**
 * The world clock, in the two shapes a table uses it (§5.5): the integral seconds every subsystem
 * spends, and the hour of day the fiction is set in. One clock, never two — a round is
 * `secondsPerRound`, an hour 600 rounds, a day 14 400.
 */
export interface AgentClock {
  seconds: number;
  /** `1d 02:03:04` — the settings window's own readout. */
  stamp: string;
  /** 0–23. */
  hour: number;
  minute: number;
  phase: "day" | "night";
  /** Whole days elapsed — what a hex map's "day 4" column shows. */
  day: number;
  /** `14:20`. */
  label: string;
  secondsPerRound: number;
  /** Whether a combat round wrap advances the clock in this world. */
  advanceOnRound: boolean;
}

/** Time passing, bundled: the clock ops, and the effects the new time ended. */
export interface AgentTimeOps {
  /** The clock after the change. */
  seconds: number;
  /** What it moved by — negative for a GM correction, which expires nothing. */
  delta: number;
  ops: Op[];
  /** Clock-counted effects the sweep stripped, named so an agent can say which buffs dropped. */
  expired: Array<{ home: "actors" | "combats"; ownerId: string; effectId: string }>;
}

/** The encounter on a scene, as the tracker shows it. */
export interface AgentCombatState {
  id: string;
  name: string;
  round: number;
  /** 0-based index into `order`; the tracker's own number. */
  turn: number;
  started: boolean;
  /** `"surprise"` during a PF1e surprise round, else null. */
  phase: string | null;
  current: AgentCombatantRow | null;
  /** Initiative order, current first-marked. */
  order: AgentCombatantRow[];
}

export interface AgentCombatantRow {
  id: string;
  name: string;
  initiative: number | null;
  defeated: boolean;
  hidden: boolean;
  tokenId: string | null;
  actorId: string | null;
  isCurrent: boolean;
}

/** One combat transition: the state after it, the ops that carry it, and what the table hears. */
export interface AgentCombatTurn extends AgentCombatState {
  /** Seconds the world clock moved — a round wrap, when this world advances it. */
  clockDeltaSeconds: number;
  ops: Op[];
  /** What happened, in the tracker's own words: "surprise round", "round 2", "combat ended". */
  note: string | null;
  /**
   * Dying combatants whose turn just started: they owe a stabilization check the transition
   * itself never rolls. Named so a GM agent can roll it (or say it out loud) rather than
   * silently skipping a rule.
   */
  dyingChecks: Array<{ combatantId: string; actorId: string; actorName: string; hp: number }>;
}

/**
 * One roll, as the host rolled it (§5.5). The terms are the host's, so the answer can show the
 * individual dice — a model that has to describe "a 6 and a 3" needs more than the total, and a
 * total it computed itself would not be the table's.
 */
export interface AgentDiceRoll {
  messageId: string;
  formula: string;
  total: number;
  /** The individual dice and modifiers, in the dice engine's own shape. */
  terms: Json[];
  mode: string;
  /** Who the roll was whispered to, when it was one. */
  to: string[];
  /** The card's flavor line, when the caller set one. */
  flavor: string | null;
}

/**
 * The result of applying a card (§5.5): the host's own arithmetic, read back after the fact.
 * `amount` is the card's total — the agent never states a number — and the hit points are what the
 * actor's sheet says before and after, because temp HP absorbs first and that is the host's rule.
 */
export interface AgentDiceApply {
  messageId: string;
  actorId: string;
  actorName: string;
  mode: "damage" | "healing";
  amount: number;
  hpBefore: number;
  hpAfter: number;
  /** The host's own one-line account: `8 damage — hp 12 → 4 (temporary hit points absorbed 4)`. */
  note: string | null;
}

export interface AgentHexSummary {
  sceneId: string;
  sceneName: string;
  grid: AgentSceneSummary["grid"];
  /** Authored cells this replica holds: a player's are the open ones only. */
  cells: number;
  open: number;
  /** Cells per terrain, in catalog order. */
  byTerrain: Array<{ id: string; name: string; count: number; cost: number }>;
  /** Where the party stands, when the scene has a party token. */
  party: { key: string; col: number; row: number } | null;
  /** The terrain catalog these names came from, so an answer can be traced to it. */
  catalog: string;
  /** The scene's travel plan, when it has one — the numbers a march is priced with. */
  travel: { speedPerDay: number; pace: string } | null;
}

/** The route the party is walking, and what walking the rest of it costs. */
export interface AgentTravelPlan {
  sceneId: string;
  /** The committed route, cell keys in order. */
  path: string[];
  /** How far along it the party is: the cell it is walking *from*, and the progress into that step. */
  cursor: number;
  progressSeconds: number;
  speedPerDay: number;
  pace: string;
  /** The cells still ahead, and the seconds the whole remainder costs at this pace. */
  remaining: string[];
  remainingSeconds: number;
  /** The party token, when the profile names one that still exists. */
  party: { key: string; tokenId: string } | null;
}

/**
 * What one march is: the ops, and the facts about them. The agent's advance is **one envelope**
 * where the UI's is two — the clock and the sweep, the route's progress, the party's move, the
 * feature reveals and the chat cards that announce them all land together, because a model has no
 * listeners to keep in step and a half-applied march is a world nobody can describe.
 */
export interface AgentTravelAdvance {
  ops: Op[];
  /** Seconds the march took. */
  seconds: number;
  /** Where the party ended up. */
  arrival: string | null;
  /** True when it ran out of route (the rest of the time was spent where it arrived). */
  arrived: boolean;
  /** Every border crossed, in order — the encounter engine's own input. */
  steps: Array<{ cellKey: string; seconds: number; triggers: string[] }>;
  /** Features the march's time earned, and the hex they are in. */
  revealed: Array<{ cellKey: string; names: string[] }>;
  /** Seconds charged to each cell — the clock a "found after N hours" rule measures. */
  spent: Record<string, number>;
}

/** What the encounter engine says about one cell right now. */
export interface AgentEncounterCheck {
  /** The ledger write, empty unless a table actually fired. */
  ops: Op[];
  action: "none" | "roll" | "prompt" | "manual";
  /** Why nothing happened, when nothing did (`no-tables`, `cooldown`, …). */
  reason: string | null;
  cellKey: string;
  /** Daylight band the engine read the clock as (`day` / `night`). */
  phase: string;
  /** The tables attached here that *would* fire — what a `manual` mode hands the GM. */
  eligible: Array<{ id: string; name: string }>;
  /** Set when a table fired: the die, the entry, and the actors it names. */
  roll: {
    tableId: string;
    tableName: string;
    formula: string;
    roll: number;
    die: number;
    text: string;
    count: number;
    /** Resolved actor ids from the entry's refs — what `encounter.place` puts on the map. */
    actorIds: string[];
  } | null;
}

/**
 * Everything `hexmap.render` needs, decided where the data is: the region, the legend and the
 * glyphs. The renderer stays pure, and a 20 000-hex world is clamped here rather than in the tool's
 * answer — the map is a window, and it says so.
 */
export interface AgentHexMapPlan {
  options: HexMapOptions;
  glyphs: HexGlyph[];
}

/** One compendium entry, as the packs hold it — what `actor.from_compendium` creates. */
export interface AgentCompendiumEntry {
  id: string;
  name: string;
  /** The pack it came from, so the answer can say where the creature was found. */
  pack: string;
  /** The pack's target collection: an `actors` pack imports as an actor, a `feats` pack does not. */
  coll: string;
  /**
   * The create payload, exactly as the Compendia panel's own Import button submits it — the
   * document a GM's click would land, not a re-derivation of it.
   */
  data: Json;
}

/**
 * What the D-264/D-267 importer made of a pasted character: the ops it becomes, plus the report the
 * UI shows a GM (what was read, and what the source stated that this app does not place).
 */
export interface AgentImportPlan {
  name: string;
  /** `stat block`, `Foundry PF1e actor`, … — the importer's own name for the format it read. */
  format: string;
  ops: Op[];
  read: string[];
  warnings: string[];
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
  /**
   * The card carries a roll whose result this replica does not hold (a `gmroll`/`blindroll`
   * the agent did not roll and may not read). `projectMessage` redacts by nulling `roll`, and the
   * view strips the total out of the content chip as well — see `agentBridge.ts`.
   */
  resultWithheld: boolean;
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

/**
 * §6.2 — the write path. One tool call builds one `Op[]` and submits it as **one envelope**, so
 * the GM's undo is one click and the OpLog has exactly one line to attribute.
 *
 * It is a narrow port on purpose: the tool table never sees `ClientSync`, and a test can hand a
 * tool a writer that records what it was asked to do.
 */
export interface AgentWriter {
  /**
   * Submit one envelope and wait for the host's verdict. The answer is the *host's*, not an echo
   * of the request: a refusal carries the reason the host gave (`forbidden`, `rate_limited`, …),
   * which is the sentence a model needs in order to stop retrying.
   */
  submit(ops: Op[]): Promise<AgentSubmitResult>;
  /**
   * §5.1 — undo the last undoable change, **if this agent authored it**. The stack is the host's
   * and only its top can be popped, so "not yours" is a refusal, not a search: an agent may never
   * undo the GM's move or another player's.
   */
  undoOwn?(): Promise<AgentUndoResult>;
}

export type AgentUndoResult =
  { ok: true; what: string } | { ok: false; error: string };

export type AgentSubmitResult =
  | { ok: true; seq: number; txId: string }
  | {
      ok: false;
      reason: RejectionReason | "timeout" | "offline";
      error: string;
    };

export interface ToolContext {
  view: AgentWorldView;
  grant: AgentGrant;
  /**
   * Absent on a read-only connection, and every write tool says so in those words: "this
   * connection cannot write" is a fact an agent can route around, "document.update is broken" is
   * not.
   */
  writer?: AgentWriter;
  /** The identity the write will be attributed to (§3.1) — null before the session is bound. */
  agentId?: string | null;
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
      /**
       * For `array`: what is in it. A model told "actors is an array" has to guess the element, and
       * a guess is a malformed call — the description says it in words, this says it in the schema
       * the client validates against.
       */
      items?: { type: "string" | "number" | "integer" | "boolean" | "object" };
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
