import { describe, expect, test } from "vitest";
import { macroSlots, runMacroSlot } from "../../src/ui/macros/run";
import type { ClientSync } from "../../src/client/sync";
import type { MacroDocument } from "../../src/core/documents";

function macro(id: string, kind: MacroDocument["kind"], extra: Record<string, unknown> = {}): MacroDocument {
  return {
    _id: id,
    type: "macro",
    name: `Macro ${id}`,
    ownership: { default: 1 },
    flags: {},
    system: {},
    kind,
    command: "hello",
    ...extra,
  } as MacroDocument;
}

function withSlot(document: MacroDocument, slot: number): MacroDocument {
  return { ...document, flags: { core: { slot } } };
}

/** Records every call the slot dispatch makes; nothing else is needed. */
function stubClient(events: string[], user: string | null = "u-1"): ClientSync {
  return {
    user: user ? { id: user } : null,
    invokeMacro: (id: string) => (events.push(`invoke:${id}`), `req-${id}`),
    requestMacro: (id: string) => (events.push(`script:${id}`), `req-${id}`),
    requestSequence: (id: string, scene: string) => (events.push(`seq:${id}@${scene}`), `req-${id}`),
    roll: (formula: string, kind: string) => events.push(`roll:${formula}:${kind}`),
    submit: () => events.push("submit"),
  } as unknown as ClientSync;
}

describe("macro hotbar slots (MC-01)", () => {
  test("only slots 1-5 bind, and the last macro on a slot wins", () => {
    const slots = macroSlots([
      withSlot(macro("a", "chat"), 0),
      withSlot(macro("b", "chat"), 1),
      withSlot(macro("c", "automation"), 6),
      withSlot(macro("d", "chat"), 5),
      withSlot(macro("e", "chat"), 1),
    ]);
    expect(slots).toHaveLength(5);
    expect(slots.map((m) => m?._id ?? null)).toEqual(["e", null, null, null, "d"]);
  });

  test("an empty list leaves five empty slots", () => {
    expect(macroSlots([]).every((slot) => slot === null)).toBe(true);
  });

  test("a chat macro submits through the chat core", () => {
    const events: string[] = [];
    const outcome = runMacroSlot(stubClient(events), macro("a", "chat"));
    expect(outcome.ok).toBe(true);
    expect(events).toEqual(["submit"]);
  });

  test("a chat macro that is a roll command rolls instead of submitting", () => {
    const events: string[] = [];
    runMacroSlot(stubClient(events), macro("a", "chat", { command: "/roll 1d20+5" }));
    expect(events).toEqual(["roll:1d20+5:roll"]);
  });

  test("an automation macro asks the host by id and reports its request id", () => {
    const events: string[] = [];
    const outcome = runMacroSlot(stubClient(events), macro("auto", "automation"));
    expect(events).toEqual(["invoke:auto"]);
    expect(outcome).toEqual({ ok: true, requestId: "req-auto" });
  });

  test("a script macro runs directly, or asks the shell to collect its required inputs", () => {
    const events: string[] = [];
    const plain = macro("s1", "script", { script: { version: 1, inputs: [] } });
    expect(runMacroSlot(stubClient(events), plain).ok).toBe(true);
    expect(events).toEqual(["script:s1"]);

    const required = macro("s2", "script", {
      script: { version: 1, inputs: [{ name: "target", type: "string", required: true }] },
    });
    const seen: string[] = [];
    const outcome = runMacroSlot(stubClient(events), required, { onNeedsInput: () => seen.push("collect") });
    expect(outcome.ok).toBe(false);
    expect(seen).toEqual(["collect"]);
    expect(events).toEqual(["script:s1"]);
  });

  test("a sequence macro needs the caller's active scene", () => {
    const events: string[] = [];
    const seq = macro("q1", "sequence");
    expect(runMacroSlot(stubClient(events), seq, { activeSceneId: () => "scene-9" }).ok).toBe(true);
    expect(events).toEqual(["seq:q1@scene-9"]);

    const missing = runMacroSlot(stubClient(events), seq, { activeSceneId: () => null });
    expect(missing.ok).toBe(false);
    expect(missing.error).toContain("open a scene");
    expect(events).toEqual(["seq:q1@scene-9"]);
  });

  test("a kind with its own surface is named rather than run", () => {
    const events: string[] = [];
    for (const kind of ["summon", "fxPreset"] as const) {
      const outcome = runMacroSlot(stubClient(events), macro("x", kind));
      expect(outcome.ok).toBe(false);
      expect(outcome.error).toContain(kind);
    }
    expect(events).toEqual([]);
  });

  test("a chat macro still submits before the session knows its user", () => {
    const events: string[] = [];
    // A chat macro still submits (the author is the empty string); the slot runner never
    // throws when the session is not signed in yet.
    runMacroSlot(stubClient(events, null), macro("a", "chat"));
    expect(events).toEqual(["submit"]);
  });
});
