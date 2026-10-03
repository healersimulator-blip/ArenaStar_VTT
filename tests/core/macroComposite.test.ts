/**
 * MC-01 (D-386) — a composite macro is a **list of references**, and the list is
 * private. These assertions are about documents rather than clicks: the child ids are
 * exactly what a player must never hold, because naming a macro the host would only
 * reach through live publication is how a composite could otherwise become an
 * authority shortcut.
 */
import { describe, expect, test } from "vitest";
import {
  MACRO_COMPOSITE_LIMITS,
  macroCompositeBindingError,
  macroCompositeDocumentError,
  macroCompositeMacroIds,
  macroStrayCompositeError,
} from "../../src/core/macroComposite";
import { macroAutomationDocumentError } from "../../src/core/macroAutomation";
import { projectEnvelope, projectWorld, type ProjectionResolver } from "../../src/core/projection";
import type { Json, MacroDocument } from "../../src/core/documents";
import type { PermissionUser } from "../../src/core/ownership";
import type { Op, OpEnvelope } from "../../src/core/ops";
import { emptyWorld } from "../net/fixtures";

const gm: PermissionUser = { id: "gm-key", role: "GM" };
const player: PermissionUser = { id: "pl-key", role: "PLAYER" };

const composite = (patch: Partial<MacroDocument> = {}): MacroDocument => ({
  _id: "comp-macro", type: "macro", name: "Opening script", ownership: { default: 1 },
  flags: { core: { slot: 2 } }, system: {}, kind: "composite", command: "",
  composite: { macroIds: ["auto-a", "auto-b"] }, ...patch,
});

const resolver: ProjectionResolver = { resolve: () => undefined };
let tx = 0;
const env = (ops: Op[]): OpEnvelope => ({ seq: 1, ts: 0, by: "gm-key", ops, txId: `tx-${++tx}` });

describe("composite macro binding (MC-01)", () => {
  test("the binding is an ordered list of distinct bounded macro ids", () => {
    expect(macroCompositeBindingError({ macroIds: ["a", "b"] })).toBeNull();
    expect(macroCompositeBindingError({ macroIds: Array.from({ length: 8 }, (_, i) => `m${i}`) })).toBeNull();
    expect(macroCompositeBindingError(undefined)).toContain("ordered list");
    expect(macroCompositeBindingError({ macroIds: ["only-one"] })).toContain("2–8");
    expect(macroCompositeBindingError({ macroIds: Array.from({ length: 9 }, (_, i) => `m${i}`) })).toContain("2–8");
    expect(macroCompositeBindingError({ macroIds: ["a", "a"] })).toContain("once");
    expect(macroCompositeBindingError({ macroIds: ["a", ""] })).toContain("bounded macro ids");
    expect(macroCompositeBindingError({ macroIds: ["a", "x".repeat(129)] })).toContain("bounded macro ids");
    expect(macroCompositeBindingError({ macroIds: ["a", "b"], extra: 1 })).toContain("exactly one list");
    expect(macroCompositeBindingError({ macroIds: "a,b" })).toContain("list of macro ids");
    expect(MACRO_COMPOSITE_LIMITS).toMatchObject({ children: 8, minimum: 2, name: 64 });
  });

  test("the document rule wants a name, no command and no other payload", () => {
    expect(macroCompositeDocumentError(composite())).toBeNull();
    expect(macroCompositeDocumentError(composite({ name: "  " }))).toContain("1–64 characters");
    expect(macroCompositeDocumentError(composite({ name: "x".repeat(65) }))).toContain("1–64 characters");
    expect(macroCompositeDocumentError(composite({ command: "/say hi" }))).toContain("not a chat command");
    for (const key of ["sequence", "script", "summon", "preset", "automation"] as const) {
      expect(macroCompositeDocumentError(composite({ [key]: {} } as Partial<MacroDocument>)),
        key).toContain("list of macros");
    }
    // A stray composite binding inside an automation macro is refused, too.
    expect(macroAutomationDocumentError({
      _id: "auto-macro", type: "macro", name: "Alert", ownership: { default: 1 }, flags: {}, system: {},
      kind: "automation", command: "", automation: { graphId: "g" }, composite: { macroIds: ["a", "b"] },
    })).toContain("not composite");
  });

  test("only a composite may carry the binding, and only a composite may read it", () => {
    expect(macroStrayCompositeError(composite())).toBeNull();
    expect(macroStrayCompositeError(composite({ kind: "chat", command: "hello" })))
      .toContain("belongs to a composite macro");
    const kindOnly = composite();
    delete kindOnly.composite; // exactOptionalPropertyTypes: build, then delete
    expect(macroStrayCompositeError(kindOnly)).toBeNull();
    expect(macroCompositeMacroIds(composite())).toEqual(["auto-a", "auto-b"]);
    expect(macroCompositeMacroIds(composite({ composite: { macroIds: ["a"] } }))).toBeNull();
    // A malformed import cannot be read as a list either.
    expect(macroCompositeMacroIds({ kind: "composite", composite: { macroIds: ["a", "a"] } })).toBeNull();
    expect(macroCompositeMacroIds({ kind: "automation", composite: { macroIds: ["a", "b"] } })).toBeNull();
  });
});

describe("composite projection (MC-01)", () => {
  const withMacro = (doc: MacroDocument) => ({ ...emptyWorld(), macros: [doc] });

  test("a player's snapshot keeps the callable entry and loses the child list", () => {
    const world = withMacro(composite());
    const entry = projectWorld(world, 1, player).collections.macros?.[0] as MacroDocument | undefined;
    expect(entry?.kind).toBe("composite");
    expect(entry?.name).toBe("Opening script");
    expect(entry?.composite).toBeUndefined();
    expect(entry?.flags).toEqual({ core: { slot: 2 } });
    // The GM keeps it.
    const own = projectWorld(world, 1, gm).collections.macros?.[0] as MacroDocument | undefined;
    expect(own?.composite).toEqual({ macroIds: ["auto-a", "auto-b"] });
  });

  test("the create path strips the list before it reaches a player", () => {
    const projected = projectEnvelope(env([{ kind: "create", coll: "macros", data: composite() }]), player, resolver);
    const op = projected?.ops[0] as Extract<Op, { kind: "create" }>;
    const data = op.data as unknown as MacroDocument;
    expect(data.composite).toBeUndefined();
    expect(data.name).toBe("Opening script");
  });

  test("a rebind replaces the whole shape — the new list never reaches a player either", () => {
    const doc = composite({ composite: { macroIds: ["auto-c", "auto-d"] } });
    const projected = projectEnvelope(env([{ kind: "update", ref: { coll: "macros", id: "comp-macro" },
      diff: { composite: { macroIds: ["auto-c", "auto-d"] } as unknown as Json } }]), player,
      { resolve: (ref) => (ref.id === "comp-macro" ? (doc as unknown as never) : undefined) });
    const op = projected?.ops[0] as Extract<Op, { kind: "update" }>;
    expect(op.diff.composite).toBeNull();
    expect(op.diff.kind).toBe("composite");
  });

  test("the envelope-only path (no resolver) still blanks the binding", () => {
    const projected = projectEnvelope(env([{ kind: "update", ref: { coll: "macros", id: "comp-macro" },
      diff: { composite: { macroIds: ["auto-c", "auto-d"] } as unknown as Json } }]), player,
      { resolve: () => undefined });
    const op = projected?.ops[0] as Extract<Op, { kind: "update" }>;
    expect(op.diff.composite).toBeNull();
    expect(JSON.stringify(op.diff)).not.toContain("auto-c");
  });
});
