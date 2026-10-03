import { describe, expect, test } from "vitest";
import type { Json, MacroDocument, UserDocument } from "../../src/core/documents";
import type { Op, OpEnvelope } from "../../src/core/ops";
import type { PermissionUser } from "../../src/core/ownership";
import { projectEnvelope, projectWorld } from "../../src/core/projection";
import { buildPlayerMacro, canSaveWorldMacros, ownsPlayerMacro, playerMacroAuthoring,
  PLAYER_MACRO_LIMITS, projectPlayerMacroAuthoring, UNAPPROVED_SCRIPT_HASH, validatePlayerMacroDraft,
  type PlayerMacroDraft } from "../../src/core/playerMacros";
import { validateScriptMacro } from "../../src/core/scriptMacros";
import { emptyWorld } from "../net/fixtures";

const author: PermissionUser = { id: "author", role: "PLAYER" };
const other: PermissionUser = { id: "other", role: "PLAYER" };
const gm: PermissionUser = { id: "gm", role: "GM" };
const chat: PlayerMacroDraft = { kind: "chat", name: "My roll", command: "/roll 1d20" };
const script: PlayerMacroDraft = { kind: "script", name: "My script", command: "return { note: args.note };",
  sceneId: "s1", inputs: [{ name: "note", type: "string", required: true }] };
const user = (id: string, permission?: boolean): UserDocument => ({ _id: id, type: "user", name: id,
  ownership: { default: 0 }, flags: {}, system: {}, role: "PLAYER", color: "#fff", character: null,
  ...(permission !== undefined ? { canSaveMacros: permission } : {}) });
const envelope = (op: Op): OpEnvelope => ({ seq: 2, ts: 1, by: "gm", txId: "test", ops: [op] });
const ref = { coll: "macros" as const, id: "personal" };

function revised(): MacroDocument {
  const original = buildPlayerMacro(ref.id, author.id, script);
  return { ...original, command: "// GM_PRIVATE_SOURCE\nreturn { private: 'GM_PRIVATE_RESULT' };",
    flags: { core: { playerCallable: true, slot: 2 }, private: { value: "GM_PRIVATE_FLAGS" } },
    system: { private: "GM_PRIVATE_SYSTEM" },
    script: { version: 1, approvedHash: "a".repeat(64), sceneId: "GM_PRIVATE_SCENE", runAs: "gm",
      grants: ["chat"], playerCallable: true, inputs: [{ name: "gmInput", type: "number" }],
      prefabIds: ["GM_PRIVATE_PREFAB"] },
    scriptState: { recent: [{ key: "GM_PRIVATE_HISTORY", at: 1, revision: "a".repeat(64) }] } };
}

describe("D-394 personal world-macro draft contract", () => {
  test("saving is off by default for PLAYER and TRUSTED, not an implicit ownership grant", () => {
    expect(canSaveWorldMacros(null, [user(author.id, true)])).toBe(false);
    expect(canSaveWorldMacros(author, [])).toBe(false);
    expect(canSaveWorldMacros(author, [user(author.id)])).toBe(false);
    expect(canSaveWorldMacros(author, [user(author.id, false)])).toBe(false);
    expect(canSaveWorldMacros({ ...author, role: "TRUSTED" }, [user(author.id)])).toBe(false);
    expect(canSaveWorldMacros(author, [user(other.id, true)])).toBe(false);
    expect(canSaveWorldMacros(author, [{ ...user(author.id), canSaveMacros: "true" } as unknown as UserDocument])).toBe(false);
    expect(canSaveWorldMacros(author, [user(author.id, true)])).toBe(true);
    expect(canSaveWorldMacros(gm, [])).toBe(true);
    expect(canSaveWorldMacros({ ...gm, role: "ASSISTANT" }, [])).toBe(true);
  });

  test("private ownership does not suppress the public User capability's create/update/delete delivery", () => {
    const document = user(author.id, true);
    const world = emptyWorld(); world.users.push(document);
    expect(projectWorld(world, 1, author).collections.users?.[0]).toBe(document);
    const resolver = { resolve: () => document };
    for (const op of [
      { kind: "create", coll: "users", data: document },
      { kind: "update", ref: { coll: "users", id: author.id }, diff: { canSaveMacros: true } },
      { kind: "delete", ref: { coll: "users", id: author.id } },
    ] as Op[]) expect(projectEnvelope(envelope(op), author, resolver)?.ops[0]).toBe(op);
  });

  test("canonicalize only the name; preserve source, whitespace and declared input types", () => {
    const source = "\n// Personal draft\nreturn { note: args.note };\n";
    const draft = { ...script, name: "  My script  ", command: source };
    expect(validatePlayerMacroDraft(draft)).toEqual({ ok: true, draft: { ...draft, name: "My script" } });
    expect(validatePlayerMacroDraft({ ...chat, command: "hello\n\t[[1d6]]" }).ok).toBe(true);
    expect(validatePlayerMacroDraft({ ...chat, name: "x".repeat(64), command: "x".repeat(4096) }).ok).toBe(true);
    expect(validatePlayerMacroDraft({ ...script, command: "x".repeat(16384) }).ok).toBe(true);
  });

  test.each([
    ["null", null], ["array", []], ["unsupported kind", { ...chat, kind: "sequence" }],
    ["missing kind", { name: "A", command: "A" }], ["null name", { ...chat, name: null }],
    ["blank name", { ...chat, name: "  " }], ["long name", { ...chat, name: "x".repeat(65) }],
    ["control name", { ...chat, name: "name\n" }], ["null command", { ...chat, command: null }],
    ["empty source", { ...chat, command: " \n\t" }], ["control source", { ...chat, command: "a\u0000b" }],
    ["DEL source", { ...chat, command: "a\u007fb" }], ["long chat", { ...chat, command: "x".repeat(4097) }],
    ["long script", { ...script, command: "x".repeat(16385) }],
    ["real UTF-8 budget", { ...script, command: "漢".repeat(12000) }],
    ["source is not an alternate command field", { ...chat, source: "leak" }],
    ["no ownership", { ...chat, ownership: { default: 3 } }],
    ["no flags", { ...chat, flags: { core: { slot: 1 } } }],
    ["no host history", { ...script, scriptState: { recent: [] } }],
    ["no author spoof", { ...chat, userId: "gm" }],
    ["no permission spoof", { ...chat, canSaveMacros: true }],
    ["no policy", { ...script, script: { runAs: "gm", playerCallable: true } }],
    ["no grants", { ...script, grants: ["chat"] }],
    ["no chat scene", { ...chat, sceneId: "s1" }],
    ["blank scene", { ...script, sceneId: "" }],
    ["invalid scene", { ...script, sceneId: "s/1" }],
    ["oversized scene", { ...script, sceneId: "s".repeat(129) }],
    ["missing inputs", { kind: "script", name: "A", command: "return 1", sceneId: "s1" }],
    ["null inputs", { ...script, inputs: null }],
    ["too many inputs", { ...script, inputs: Array.from({ length: 17 }, (_, i) => ({ name: `a${i}`, type: "string" })) }],
    ["duplicate inputs", { ...script, inputs: [{ name: "arg", type: "string" }, { name: "arg", type: "number" }] }],
    ["invalid input name", { ...script, inputs: [{ name: "__proto__", type: "string" }] }],
    ["unknown input type", { ...script, inputs: [{ name: "arg", type: "item" }] }],
    ["nonboolean required", { ...script, inputs: [{ name: "arg", type: "string", required: 1 }] }],
    ["input metadata injection", { ...script, inputs: [{ name: "arg", type: "string", private: "secret" }] }],
  ])("rejects %s without constructing a world document", (_name, invalid) => {
    expect(validatePlayerMacroDraft(invalid).ok).toBe(false);
  });

  test("host document construction is private, unapproved and grants no APIs or global slot", () => {
    const draft = structuredClone(script);
    const macro = buildPlayerMacro(ref.id, author.id, draft);
    expect(macro.ownership).toEqual({ default: 0, [author.id]: 3 });
    expect(macro.playerAuthoring).toEqual({ version: 1, userId: author.id, draft: script });
    expect(macro.script).toMatchObject({ version: 1, approvedHash: UNAPPROVED_SCRIPT_HASH,
      sceneId: "s1", runAs: "caller", playerCallable: false, grants: [], inputs: script.kind === "script" ? script.inputs : [] });
    expect(macro.flags).toEqual({ core: { playerCallable: false } });
    expect(validateScriptMacro(macro).ok).toBe(true); // structurally valid is NOT reviewed approval
    expect(macro.script?.approvedHash).toHaveLength(64);
    expect(PLAYER_MACRO_LIMITS.perUser).toBe(64);
    draft.command = "changed external object";
    expect(macro.command).toBe(script.command);
    expect(macro.playerAuthoring?.draft.command).toBe(script.command);
  });

  test("every revision clears elevation/publication/bindings, retains only a host slot and replay history", () => {
    const before = revised();
    const priorJson = JSON.stringify(before);
    const revision = buildPlayerMacro(ref.id, author.id, script, before);
    expect(revision.command).toBe(script.command);
    expect(revision.script).toMatchObject({ approvedHash: UNAPPROVED_SCRIPT_HASH, runAs: "caller",
      playerCallable: false, grants: [], sceneId: "s1" });
    expect(revision.script?.prefabIds).toBeUndefined();
    expect(revision.flags).toEqual({ core: { slot: 2, playerCallable: false } });
    expect(revision.system).toEqual({});
    expect(revision.scriptState).toEqual(before.scriptState);
    expect(revision.scriptState).not.toBe(before.scriptState);
    const switched = buildPlayerMacro(ref.id, author.id, chat, revision);
    expect(switched.kind).toBe("chat");
    expect(switched.script).toBeUndefined();
    expect(switched.scriptState).toEqual(before.scriptState);
    expect(switched.flags).toEqual({ core: { slot: 2 } });
    expect(buildPlayerMacro(ref.id, author.id, chat, { ...before, flags: { core: { slot: 6 } } }).flags).toEqual({ core: {} });
    expect(JSON.stringify(before)).toBe(priorJson);
  });

  test("authorship alone, ownership alone and malformed imported metadata are not management credentials", () => {
    const mine = buildPlayerMacro(ref.id, author.id, chat);
    expect(ownsPlayerMacro(author, mine)).toBe(true);
    expect(ownsPlayerMacro(other, { ...mine, ownership: { default: 3 } })).toBe(false);
    expect(ownsPlayerMacro(author, { ...mine, ownership: { default: 1 } })).toBe(false);
    expect(ownsPlayerMacro(author, { ...mine, kind: "automation" })).toBe(false);
    expect(ownsPlayerMacro(author, { ...mine, playerAuthoring: undefined } as unknown as MacroDocument)).toBe(false);
    for (const invalid of [{ ...mine.playerAuthoring, version: 2 }, { ...mine.playerAuthoring, userId: "bad/id" },
      { ...mine.playerAuthoring, private: "leak" }, { version: 1, userId: author.id, draft: { ...chat, grants: ["chat"] } }]) {
      const imported = { ...mine, playerAuthoring: invalid } as unknown as MacroDocument;
      expect(playerMacroAuthoring(imported)).toBeNull();
      expect(ownsPlayerMacro(author, imported)).toBe(false);
      expect(projectPlayerMacroAuthoring(imported, author)).toBeNull();
    }
  });
});

describe("D-394 original-source DTO has identical snapshot/create/resolved-update privacy", () => {
  test("author sees only original personal source; executable source, private policy/history stay GM-only", () => {
    const macro = revised();
    const world = emptyWorld();
    world.macros.push(macro);
    const before = JSON.stringify(world);
    const owned = projectWorld(world, 1, author).collections.macros?.[0];
    expect(owned?.playerAuthoring).toEqual({ version: 1, userId: author.id, draft: script });
    expect(owned?.command).toBe("");
    expect(owned?.script?.inputs).toEqual([{ name: "gmInput", type: "number" }]);
    expect(JSON.stringify(owned)).not.toContain("GM_PRIVATE");
    expect(projectWorld(world, 1, other).collections.macros).toEqual([]);
    expect(projectWorld(world, 1, gm).collections.macros?.[0]).toBe(macro);
    expect(JSON.stringify(world)).toBe(before);

    const publicMacro = { ...macro, ownership: { default: 1 as const, [author.id]: 3 as const } };
    const resolver = { resolve: () => publicMacro };
    const create = envelope({ kind: "create", coll: "macros", data: publicMacro });
    const ownerCreate = projectEnvelope(create, author, resolver)?.ops[0];
    expect(ownerCreate?.kind).toBe("create");
    if (ownerCreate?.kind === "create") {
      expect((ownerCreate.data as MacroDocument).playerAuthoring?.draft.command).toBe(script.command);
      expect((ownerCreate.data as MacroDocument).command).toBe("");
    }
    const otherCreate = projectEnvelope(create, other, resolver)?.ops[0];
    if (otherCreate?.kind === "create") expect((otherCreate.data as MacroDocument).playerAuthoring).toBeUndefined();
    expect(JSON.stringify(otherCreate)).not.toContain(script.command);
    const update = envelope({ kind: "update", ref, diff: { command: publicMacro.command,
      "playerAuthoring.draft.command": "untrusted raw partial source" } });
    const ownerUpdate = projectEnvelope(update, author, resolver)?.ops[0];
    if (ownerUpdate?.kind === "update") {
      expect(ownerUpdate.diff.command).toBe("");
      expect(ownerUpdate.diff.playerAuthoring).toEqual(publicMacro.playerAuthoring);
    } else throw new Error("owner update omitted");
    const otherUpdate = projectEnvelope(update, other, resolver)?.ops[0];
    if (otherUpdate?.kind === "update") expect(otherUpdate.diff.playerAuthoring).toBeNull();
    expect(JSON.stringify(ownerUpdate)).not.toMatch(/GM_PRIVATE|untrusted raw partial source/);
    expect(JSON.stringify(otherUpdate)).not.toContain(script.command);
  });

  test("revoked management rights and removed author metadata actively clear the owner DTO", () => {
    const original = revised();
    const revoked = { ...original, ownership: { default: 1 as const } };
    expect(projectPlayerMacroAuthoring(revoked, author)).toBeNull();
    const op = projectEnvelope(envelope({ kind: "update", ref, diff: { ownership: revoked.ownership } }), author,
      { resolve: () => revoked })?.ops[0];
    if (op?.kind === "update") {
      expect(op.diff.playerAuthoring).toBeNull();
      expect(op.diff.command).toBe("");
    } else throw new Error("visible revoked macro update missing");
    const noAuthor = buildPlayerMacro(ref.id, author.id, chat);
    delete noAuthor.playerAuthoring;
    const removed = projectEnvelope(envelope({ kind: "update", ref, diff: { "-=playerAuthoring": true } }), author,
      { resolve: () => noAuthor })?.ops[0];
    if (removed?.kind === "update") expect(removed.diff.playerAuthoring).toBeNull();
    else throw new Error("author DTO clear missing");
  });

  test.each(["playerAuthoring", "playerAuthoring.userId", "playerAuthoring.draft", "playerAuthoring.draft.command",
    "-=playerAuthoring", "-=playerAuthoring.draft.command", "playerAuthoring.-=draft"])(
    "resolver-less updates never forward %s", (path) => {
      const op = projectEnvelope(envelope({ kind: "update", ref, diff: { [path]: "PRIVATE_AUTHOR_SOURCE" as Json } }), other)?.ops[0];
      expect(JSON.stringify(op)).not.toContain("PRIVATE_AUTHOR_SOURCE");
      if (op?.kind === "update") expect(op.diff[path]).toBeNull();
      else throw new Error("conservative author diff missing");
    });

  test("resolver-less macro updates conservatively redact executable source and policy paths too", () => {
    const fields = ["command", "script", "script.approvedHash", "script.grants", "scriptState.recent", "flags.core.private", "system.private"];
    const diff = Object.fromEntries(fields.map((field) => [field, "PRIVATE_EXECUTABLE_SOURCE"]));
    const projected = projectEnvelope(envelope({ kind: "update", ref, diff }), author);
    expect(JSON.stringify(projected)).not.toContain("PRIVATE_EXECUTABLE_SOURCE");
  });
});
