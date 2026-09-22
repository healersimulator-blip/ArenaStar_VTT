/**
 * MCP connector §5 — the tool table, rendered as markdown.
 *
 * `MCP_CONNECTOR.md` is the reference a GM reads, and a hand-written tool table is a table that
 * drifts: add a tool, forget the doc, and the doc lies. So the table is **rendered from the
 * registry** (`AGENT_TOOLS`, the same list `tools/list` serves) and a test asserts the file still
 * contains it — drift fails the suite, and `UPDATE_AGENT_DOCS=1` rewrites the section.
 *
 * Rendering lives here rather than in the doc test because it is the same kind of thing the rest of
 * `core/agents` does: a pure function over the catalogue, with no world to read.
 */
import { AGENT_TOOLS } from "./tools";
import type { ToolArgsSchema, ToolDefinition } from "./types";

/** One row of the summary table: what it is called, what it does, and who may call it. */
interface Row {
  name: string;
  capability: string;
  description: string;
}

const capabilityOf = (tool: ToolDefinition): string => tool.capability ?? "— (always answerable)";

/** The families, in the order a reader meets them (§5.2 → §5.6). */
const FAMILIES: ReadonlyArray<{ title: string; prefix: string; blurb: string }> = [
  { title: "World and scenes", prefix: "scene.", blurb: "What the table is looking at." },
  { title: "The map", prefix: "map.render", blurb: "The canvas as text." },
  { title: "Documents", prefix: "document.", blurb: "The world's own records." },
  { title: "Actors and sheets", prefix: "sheet.", blurb: "Derived numbers, not stored ones." },
  {
    title: "Bestiary",
    prefix: "bestiary.",
    blurb: "Search the compendia, and import from them.",
  },
  {
    title: "The hexcrawl",
    prefix: "hex",
    blurb: "The overworld: cells, the map, the march and what finds you on it.",
  },
  { title: "Chat", prefix: "chat.", blurb: "Speaking, whispering and reading." },
  {
    title: "The clock",
    prefix: "time.",
    blurb: "One clock, in seconds, and the hour it means.",
  },
  {
    title: "The turn tracker",
    prefix: "combat.",
    blurb: "The encounter's round structure.",
  },
  { title: "Dice", prefix: "dice.", blurb: "Rolled by the host, never by the agent." },
  { title: "Fog", prefix: "fog.", blurb: "What the table can see." },
  {
    title: "The strategic layer",
    prefix: "strategic.",
    blurb: "Armies, their orders, and the turn's report.",
  },
  { title: "Tokens", prefix: "token.", blurb: "Moving and changing what is on the canvas." },
];

const familyOf = (name: string): string => {
  if (name.startsWith("hexcrawl.") || name.startsWith("hex.") || name.startsWith("travel."))
    return "hex";
  if (name.startsWith("encounter.")) return "hex";
  if (name.startsWith("hexmap.")) return "hex";
  const hit = FAMILIES.find((family) => name.startsWith(family.prefix));
  return hit?.prefix ?? "other";
};

const argLines = (args: ToolArgsSchema): string[] => {
  const entries = Object.entries(args.properties ?? {});
  if (entries.length === 0) return [];
  const required = new Set(args.required ?? []);
  return entries.map(([key, spec]) => {
    const type =
      spec.type === "array" && spec.items ? `${spec.items.type}[]` : (spec.type ?? "any");
    return `    - \`${key}\` (${type}${required.has(key) ? ", required" : ""}) — ${spec.description ?? ""}`;
  });
};

/** The whole tool table: a summary row per tool, then one block per tool with its arguments. */
export function renderToolDocs(): string {
  const lines: string[] = [];
  const rows: Row[] = AGENT_TOOLS.map((tool) => ({
    name: tool.name,
    capability: capabilityOf(tool),
    description: tool.description,
  }));
  lines.push(
    "<!-- GENERATED: this table is rendered from the tool registry by",
    "`src/core/agents/docs.ts` and asserted by `tests/core/agentsDocs.test.ts`. Edit the tools,",
    "then re-run that test with `UPDATE_AGENT_DOCS=1` — do not hand-edit the rows below. -->",
    "",
  );
  for (const family of FAMILIES) {
    const members = AGENT_TOOLS.filter((tool) => familyOf(tool.name) === family.prefix);
    if (members.length === 0) continue;
    lines.push(`### ${family.title}`, "", `${family.blurb}`, "");
    for (const tool of members) {
      const args = argLines(tool.args);
      lines.push(
        `**\`${tool.name}\`** — capability \`${capabilityOf(tool)}\``,
        "",
        tool.description,
        "",
        ...(args.length > 0 ? ["  Arguments:", ...args, ""] : ["  _Takes no arguments._", ""]),
      );
    }
  }
  // The summary table first, so a reader can scan before they read.
  const table = [
    "| Tool | Capability |",
    "|---|---|",
    ...rows.map((row) => `| \`${row.name}\` | \`${row.capability}\` |`),
  ];
  return [table.join("\n"), "", ...lines].join("\n");
}

/** The section as it sits inside `MCP_CONNECTOR.md`, markers and all. */
export const DOC_SECTION_START = "<!-- BEGIN GENERATED TOOLS -->";
export const DOC_SECTION_END = "<!-- END GENERATED TOOLS -->";

export function renderToolSection(): string {
  return [DOC_SECTION_START, "", renderToolDocs(), DOC_SECTION_END].join("\n");
}

/** The count, for the doc's prose and for a test that notices a tool with no row. */
export const toolCount = (): number => AGENT_TOOLS.length;
