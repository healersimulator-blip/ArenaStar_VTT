/**
 * MCP connector §10 — the Help → *Agents* page, as data.
 *
 * The copy lives here rather than inside the panel for the same reason the tool table is generated
 * (`docs.ts`): the numbers in it are **read from the catalogue**, so a page that says "the player
 * preset holds 8 capabilities" cannot survive a change to `PRESETS`. The prose is a pure function
 * over `capabilities.ts`, and it is unit-tested in `tests/core/agentsHelp.test.ts`.
 *
 * Shown to players as well as GMs: the people an agent can read about are entitled to know what it
 * can see. Only the granting and revoking rows are the GM's.
 */
import {
  AGENT_CAPABILITIES,
  AGENT_PRESETS,
  PRESETS,
  PRESET_ROLE,
  type AgentPreset,
} from "./capabilities";
import type { Role } from "../documents";

export interface AgentHelpRow {
  term: string;
  detail: string;
}

export interface AgentHelpPreset {
  id: AgentPreset;
  role: Role;
  /** How many capabilities it holds — read, never written. */
  count: number;
  note: string;
}

export interface AgentHelpSection {
  title: string;
  prose: string[];
  rows: readonly AgentHelpRow[];
  presets: readonly AgentHelpPreset[];
  /** How to take an agent's access away, and what happens to what it did. */
  gmRows: readonly AgentHelpRow[];
}

const NOTES: Record<AgentPreset, string> = {
  gm: "Everything, including the GM's own data: hidden tokens, whispers and GM-only roll results. Exactly as powerful as the GM's tab — say so out loud before you enable it.",
  "gm-no-delete": "Everything except deleting documents. The right default for an agent you are still getting to know.",
  player:
    "Its own projection: what a player reads, speaking, rolling, and the tokens it owns. It cannot read the GM's data, and it cannot walk the party across the map.",
  observer: "Reads the world and the chat and changes nothing: no speaking, no moving, no writing.",
};

/**
 * The page. `presets` is built from `PRESETS` so a grant the code no longer offers is a row the page
 * no longer shows, and a count that changed is a count the page gets right.
 */
export function agentHelp(): AgentHelpSection {
  return {
    title: "Agents",
    prose: [
      "An agent is a language model sitting at the table over MCP — the protocol Claude Desktop and " +
        "other clients speak. It reads the world, rolls dice, moves tokens and writes documents, and it " +
        "does all of it as a user of its own, with a session of its own.",
      "The host stays the only authority. An agent's ops go through the same pipeline and the same " +
        `checks as yours, so a bug in the connector cannot hand a player-scoped agent a GM write. Of the ` +
        `${AGENT_CAPABILITIES.length} capabilities a grant is made of, the GM hands over only the ones ` +
        "they tick.",
    ],
    rows: [
      {
        term: "What it can see",
        detail:
          "Its own projection — the same document a player's screen holds. Anything it may not read is absent from the answer, not blanked out afterwards.",
      },
      {
        term: "What it cannot do",
        detail:
          "Name the numbers on a die. It asks the host to roll and applies what the host rolled; the dice are the table's, not the model's.",
      },
      {
        term: "What it leaves behind",
        detail:
          "Every write is attributed to it in the OpLog, so an agent's work is undoable in one click like anyone else's.",
      },
      {
        term: "When it is told no",
        detail:
          "A refusal names what is missing — \"this agent may not delete documents — ask the GM to change its grant\". It is an answer, not an error to work around.",
      },
    ],
    presets: AGENT_PRESETS.map((id) => ({
      id,
      role: PRESET_ROLE[id],
      count: PRESETS[id].length,
      note: NOTES[id],
    })),
    gmRows: [
      {
        term: "Granting",
        detail:
          "Settings → Agents → Add. The grant lives in a replicated document, so it survives a reload and every replica can see what was allowed.",
      },
      {
        term: "Narrowing",
        detail:
          "Untick a capability in the agent's Edit pane. A tick outside its preset does not apply — changing the preset is how an agent gets more, never a tick box.",
      },
      {
        term: "Revoking",
        detail:
          "Revoke, one click, any time. Every op it submitted stays in the OpLog under its name, so the table keeps the record of what it did.",
      },
      {
        term: "Watching it work",
        detail:
          "Tick \"Post a GM-only chat card for every write\" and the table sees each change as it happens, without the players seeing the card.",
      },
    ],
  };
}
