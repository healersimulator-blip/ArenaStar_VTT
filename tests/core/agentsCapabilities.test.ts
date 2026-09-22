// MCP connector §3/§4 — the capability vocabulary and the gate that decides what a grant allows.
import { describe, expect, test } from "vitest";
import {
  AGENT_CAPABILITIES,
  AGENT_PRESETS,
  PRESETS,
  PRESET_ROLE,
  allows,
  grantFor,
  narrow,
  type AgentCapability,
} from "../../src/core/agents/capabilities";

describe("agent capabilities (MCP plan §4)", () => {
  test("every preset is a subset of the vocabulary, and the vocabulary has no duplicates", () => {
    expect(new Set(AGENT_CAPABILITIES).size).toBe(AGENT_CAPABILITIES.length);
    for (const preset of AGENT_PRESETS) {
      for (const capability of PRESETS[preset]) {
        expect(AGENT_CAPABILITIES).toContain(capability);
      }
    }
  });

  test("the four presets are the four kinds of agent §3.1 names", () => {
    // A GM agent is exactly as powerful as the GM's own tab — the UI says so, because it is true.
    expect(PRESETS.gm).toHaveLength(AGENT_CAPABILITIES.length);
    // …and the recommended default for a live table is the one that cannot destroy anything.
    expect(PRESETS["gm-no-delete"].includes("doc.delete")).toBe(false);
    expect(PRESETS["gm-no-delete"].includes("doc.create")).toBe(true);
    // A player agent reads its own projection, speaks and rolls; it does not author the world.
    for (const capability of [
      "doc.create",
      "doc.update",
      "doc.delete",
      "gmOnly.read",
    ] as const) {
      expect(PRESETS.player.includes(capability)).toBe(false);
    }
    expect(PRESETS.player).toContain("world.read");
    // An observer reads and nothing else: no write capability survives.
    const writes = AGENT_CAPABILITIES.filter(
      (c) => !c.endsWith(".read") && c !== "undo",
    );
    for (const capability of writes)
      expect(PRESETS.observer.includes(capability)).toBe(false);
    // An observer reads the world and the party's map, and nothing else.
    expect(PRESETS.observer).toEqual(["world.read", "hexcrawl.read", "chat.read"]);
    // …and a player agent reads the hexcrawl but does not walk the party: a march spends the
    // table's clock, which is the GM's to spend unless the GM narrows a grant to say otherwise.
    expect(PRESETS.player).toContain("hexcrawl.read");
    expect(PRESETS.player.includes("hexcrawl.travel")).toBe(false);
  });

  test("a preset's role is the ceiling, never something the mask widens", () => {
    expect(PRESET_ROLE.gm).toBe("GM");
    expect(PRESET_ROLE["gm-no-delete"]).toBe("ASSISTANT");
    expect(PRESET_ROLE.player).toBe("PLAYER");
    expect(PRESET_ROLE.observer).toBe("PLAYER");
    expect(grantFor("observer").role).toBe("PLAYER");
  });

  test("the gate answers yes only for a capability the grant holds", () => {
    const observer = grantFor("observer");
    expect(allows(observer, "world.read").ok).toBe(true);
    const denied = allows(observer, "doc.create");
    expect(denied.ok).toBe(false);
  });

  test("a refusal says what is missing in plain words, because an LLM has to route around it", () => {
    // §4: "this agent may not delete documents — ask the GM to change its grant".
    const refusal = allows(grantFor("gm-no-delete"), "doc.delete");
    expect(refusal.ok).toBe(false);
    if (refusal.ok) return;
    expect(refusal.error).toBe(
      "this agent may not delete documents — ask the GM to change its grant",
    );
    // Every capability has a phrase: a refusal that reads "capability doc.delete denied" is a
    // refusal the model cannot learn from.
    for (const capability of AGENT_CAPABILITIES) {
      const denied = allows(grantFor("observer"), capability);
      if (denied.ok) continue;
      expect(denied.error.startsWith("this agent may not ")).toBe(true);
      expect(denied.error).toContain("— ask the GM to change its grant");
      // The message is prose, not the raw id — "undo" is the one capability whose phrase is the
      // word itself, so the rule is only checkable for the dotted ones.
      if (capability.includes("."))
        expect(denied.error).not.toContain(capability);
    }
  });

  test("a tool that needs nothing is never refused — an agent must always be able to ask who it is", () => {
    const nothing = narrow(grantFor("observer"), []);
    expect(allows(nothing, null).ok).toBe(true);
    expect(allows(nothing, "world.read" as AgentCapability).ok).toBe(false);
  });

  test("narrow() removes and never adds", () => {
    const narrowed = narrow(grantFor("gm"), ["world.read"]);
    expect(narrowed.role).toBe("GM");
    expect(allows(narrowed, "doc.delete").ok).toBe(false);
    expect(allows(narrowed, "world.read").ok).toBe(true);
    // The preset is remembered: the Agents window shows what it started from.
    expect(narrowed.preset).toBe("gm");
  });
});
