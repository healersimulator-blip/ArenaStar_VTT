// MCP connector §10 — the Help → Agents page. The copy is data (`src/core/agents/help.ts`) and its
// numbers are read from the catalogue, so the test's job is to catch a page that has come to say
// something the code no longer does.
import { describe, expect, test } from "vitest";
import { agentHelp } from "../../src/core/agents/help";
import {
  AGENT_CAPABILITIES,
  AGENT_PRESETS,
  PRESETS,
  PRESET_ROLE,
} from "../../src/core/agents/capabilities";

describe("the Help → Agents page (§10)", () => {
  test("the counts on the page are the counts in the catalogue", () => {
    const page = agentHelp();
    // A page that says "8 capabilities" when PRESETS.player has 9 is a page that lies to a GM
    // deciding how much to hand over.
    for (const preset of page.presets) {
      expect(preset.count, preset.id).toBe(PRESETS[preset.id].length);
      expect(preset.role, preset.id).toBe(PRESET_ROLE[preset.id]);
    }
    expect(page.presets.map((row) => row.id)).toEqual([...AGENT_PRESETS]);
    expect(page.prose.join(" ")).toContain(String(AGENT_CAPABILITIES.length));
  });

  test("the player preset is described as the thin one it is", () => {
    const page = agentHelp();
    const player = page.presets.find((row) => row.id === "player");
    const gm = page.presets.find((row) => row.id === "gm");
    expect(player).toBeDefined();
    expect(gm).toBeDefined();
    if (!player || !gm) return;
    // The whole safety story is that these two are not the same thing.
    expect(player.count).toBeLessThan(gm.count);
    expect(player.note).toContain("cannot read the GM's data");
    expect(gm.note).toContain("Exactly as powerful as the GM's tab");
  });

  test("the page says the host is the authority, and that the dice are the table's", () => {
    const page = agentHelp();
    const prose = page.prose.join(" ");
    expect(prose).toContain("The host stays the only authority");
    const dice = page.rows.find((row) => row.term === "What it cannot do");
    expect(dice?.detail).toContain("Name the numbers on a die");
  });

  test("a player is told what an agent can see about them, and a GM how to take it away", () => {
    const page = agentHelp();
    // Shown to players too: the people an agent reads about are owed this.
    expect(page.rows.map((row) => row.term)).toContain("What it can see");
    expect(page.rows.map((row) => row.term)).toContain("When it is told no");
    expect(page.gmRows.map((row) => row.term)).toEqual([
      "Granting",
      "Narrowing",
      "Revoking",
      "Watching it work",
    ]);
    const revoke = page.gmRows.find((row) => row.term === "Revoking");
    expect(revoke?.detail).toContain("Revoke");
    // A tick outside the preset is a trap: the page has to say it does not apply.
    const narrow = page.gmRows.find((row) => row.term === "Narrowing");
    expect(narrow?.detail).toContain("never a tick box");
  });
});
