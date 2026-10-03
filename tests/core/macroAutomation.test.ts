/**
 * TR-12/MC-01 (D-381) — an automation macro is a **reference**, and its reference is
 * private. These assertions are about documents rather than clicks: the graph id is
 * the thing a player must never hold, on the snapshot path and on the per-op path
 * (a create, a rebind and a kind transition alike), because whoever holds it can
 * name a graph the host would otherwise only reach through live publication.
 */
import { describe, expect, test } from "vitest";
import {
  MACRO_AUTOMATION_LIMITS,
  MACRO_AUTOMATION_METHOD,
  macroAutomationBindingError,
  macroAutomationDocumentError,
  macroAutomationGraphId,
  macroStrayAutomationError,
} from "../../src/core/macroAutomation";
import { projectEnvelope, projectWorld, type ProjectionResolver } from "../../src/core/projection";
import type { Json, MacroDocument } from "../../src/core/documents";
import type { PermissionUser } from "../../src/core/ownership";
import type { Op, OpEnvelope } from "../../src/core/ops";
import { emptyWorld } from "../net/fixtures";

const gm: PermissionUser = { id: "gm-key", role: "GM" };
const player: PermissionUser = { id: "pl-key", role: "PLAYER" };

const macro = (patch: Partial<MacroDocument> = {}): MacroDocument => ({
  _id: "auto-macro", type: "macro", name: "Courtyard alert", ownership: { default: 1 },
  flags: { core: { slot: 3 } }, system: {}, kind: "automation", command: "",
  automation: { graphId: "macro-graph" }, ...patch,
});

const resolver: ProjectionResolver = { resolve: () => undefined };
let tx = 0;
const env = (ops: Op[]): OpEnvelope => ({ seq: 1, ts: 0, by: "gm-key", ops, txId: `tx-${++tx}` });

describe("automation macro binding (TR-12/MC-01)", () => {
  test("the binding is one bounded graph id and nothing else", () => {
    expect(macroAutomationBindingError({ graphId: "macro-graph" })).toBeNull();
    expect(macroAutomationBindingError({ graphId: "" })).toContain("bounded graph id");
    expect(macroAutomationBindingError({ graphId: "x".repeat(129) })).toContain("bounded graph id");
    expect(macroAutomationBindingError({ graphId: "graph with spaces" })).toContain("bounded graph id");
    expect(macroAutomationBindingError({ graphId: 7 })).toContain("bounded graph id");
    expect(macroAutomationBindingError({ graphId: "g", method: "manual" })).toContain("graph id and its declared inputs");
    expect(macroAutomationBindingError([])).toContain("object");
    expect(macroAutomationBindingError(undefined)).toContain("needs a graph binding");
    expect(macroAutomationGraphId({ kind: "automation", automation: { graphId: "g-1" } })).toBe("g-1");
    expect(macroAutomationGraphId({ kind: "automation", automation: { graphId: "" } })).toBeNull();
    // The reader never guesses a graph out of a document of another kind.
    expect(macroAutomationGraphId({ kind: "chat", automation: { graphId: "g-1" } })).toBeNull();
    expect(MACRO_AUTOMATION_METHOD).toBe("manual");
  });

  test("the document rule: a reference and a name, never a second payload", () => {
    expect(macroAutomationDocumentError(macro())).toBeNull();
    const unbound = { ...macro(), _id: "unbound" } as { automation?: unknown };
    delete unbound.automation;
    expect(macroAutomationDocumentError(unbound as MacroDocument)).toContain("needs a graph binding");
    expect(macroAutomationDocumentError(macro({ command: "/me waves" }))).toContain("not a chat command");
    expect(macroAutomationDocumentError(macro({ name: "  " }))).toContain("name of 1–");
    expect(macroAutomationDocumentError(macro({ name: "x".repeat(MACRO_AUTOMATION_LIMITS.name + 1) })))
      .toContain("name of 1–");
    expect(macroAutomationDocumentError(macro({ name: "bad\u0007name" }))).toContain("name of 1–");
    expect(macroAutomationDocumentError(macro({ sequence: { version: 1, sections: [] } } as never)))
      .toContain("not sequence");
    expect(macroAutomationDocumentError(macro({ scriptState: { recent: [] } } as never)))
      .toContain("not scriptState");
    // The mirror: nobody else carries a binding.
    expect(macroStrayAutomationError(macro({ kind: "chat", command: "hello" }))).toContain("automation binding");
    expect(macroStrayAutomationError(macro())).toBeNull();
    const plain = { ...macro({ kind: "chat", command: "hello" }) } as { automation?: unknown };
    delete plain.automation;
    expect(macroStrayAutomationError(plain as MacroDocument)).toBeNull();
  });

  test("a player's snapshot holds the macro entry, the name and the slot — never the graph", () => {
    const world = { ...emptyWorld(), macros: [macro()] };
    const seen = projectWorld(world, 1, player).collections.macros ?? [];
    expect(seen).toHaveLength(1);
    expect(seen[0]?.name).toBe("Courtyard alert");
    expect(seen[0]?.kind).toBe("automation");
    expect((seen[0]?.flags as { core?: { slot?: number } }).core?.slot).toBe(3);
    expect(seen[0]?.automation).toBeUndefined();
    // The GM's own copy is untouched: the binding is what makes the macro runnable.
    const own = projectWorld(world, 1, gm).collections.macros ?? [];
    expect(own[0]?.automation).toEqual({ graphId: "macro-graph" });
  });

  test("creating, rebinding and re-kinding a macro never forwards the id to a player", () => {
    // A create arrives as a full document.
    const created = projectEnvelope(env([{ kind: "create", coll: "macros", data: macro() }]), player, resolver);
    expect(created?.ops[0]).toMatchObject({ coll: "macros" });
    const createdOp = created?.ops[0];
    expect(createdOp?.kind).toBe("create");
    expect((createdOp as unknown as { data: MacroDocument }).data.automation).toBeUndefined();

    // A plain rename does not touch the binding the player never had.
    const renamed = projectEnvelope(env([{ kind: "update", ref: { coll: "macros", id: "auto-macro" },
      diff: { name: "Courtyard bell" } }]), player, resolver);
    expect(renamed?.ops[0]).toMatchObject({ diff: { name: "Courtyard bell" } });

    // A rebind replaces the field wholesale — a partial diff would leak the new id.
    const rebound = projectEnvelope(env([{ kind: "update", ref: { coll: "macros", id: "auto-macro" },
      diff: { automation: { graphId: "other-graph" } as unknown as Json } }]), player, resolver);
    const diff = (rebound?.ops[0] as { diff: Record<string, Json | null> }).diff;
    expect(diff.automation).toBeNull();
    expect(JSON.stringify(diff)).not.toContain("other-graph");

    // A kind transition clears the field rather than leaving the old one behind.
    const rekinded = projectEnvelope(env([{ kind: "update", ref: { coll: "macros", id: "auto-macro" },
      diff: { kind: "chat", command: "hello", automation: null } }]), player, resolver);
    const kindDiff = (rekinded?.ops[0] as { diff: Record<string, Json | null> }).diff;
    expect(kindDiff.kind).toBe("chat");
    expect(kindDiff.automation).toBeNull();
  });

  test("the host's own path (with a resolver) replaces the whole macro shape", () => {
    const doc = macro();
    const resolving: ProjectionResolver = {
      resolve: (ref) => (ref.coll === "macros" && ref.id === doc._id ? doc : undefined),
    };
    const rebound = projectEnvelope(env([{ kind: "update", ref: { coll: "macros", id: "auto-macro" },
      diff: { automation: { graphId: "other-graph" } as unknown as Json } }]), player, resolving);
    const diff = (rebound?.ops[0] as { diff: Record<string, Json | null> }).diff;
    expect(diff.automation).toBeNull();
    expect(diff.scriptState).toBeNull();
    expect(diff.name).toBe("Courtyard alert");
    expect(JSON.stringify(rebound)).not.toContain("other-graph");
  });
});
