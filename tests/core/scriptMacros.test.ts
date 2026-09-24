import { describe, expect, test } from "vitest";
import type { MacroDocument } from "../../src/core/documents";
import { boundedJson, scriptApprovalHash, scriptApprovalHashSync, validateScriptArgs, validateScriptMacro,
  type ScriptPolicy } from "../../src/core/scriptMacros";

const base = (): MacroDocument => ({
  _id: "reviewed-1", type: "macro", name: "Open doors", kind: "script",
  command: "return await api.tags.find(args.tag);", ownership: { default: 1 },
  flags: {}, system: {},
});
const policy = (): Omit<ScriptPolicy, "approvedHash"> => ({
  version: 1, sceneId: "s1", runAs: "gm", playerCallable: true,
  grants: ["tags.read", "tags.write"], inputs: [
    { name: "tag", type: "string", required: true },
    { name: "source", type: "token" },
  ],
});

describe("reviewed script macro schema and inputs", () => {
  test("approval pins source, grants, scene, run-as and declared inputs", async () => {
    const m = base();
    const p = policy();
    const hash = await scriptApprovalHash(m.command, p);
    expect(scriptApprovalHashSync(m.command, p)).toBe(hash);
    expect(scriptApprovalHashSync("return '🪄✨';", p)).toBe(await scriptApprovalHash("return '🪄✨';", p));
    m.script = { ...p, approvedHash: hash };
    expect(validateScriptMacro(m)).toEqual({ ok: true, policy: m.script });
    for (const modified of [
      { ...p, runAs: "caller" as const },
      { ...p, grants: ["tags.read"] as ScriptPolicy["grants"] },
      { ...p, sceneId: "s2" },
      { ...p, playerCallable: false },
      { ...p, inputs: [{ name: "tag", type: "number" as const }] },
    ]) expect(await scriptApprovalHash(m.command, modified)).not.toBe(hash);
    expect(await scriptApprovalHash(m.command + "\n// edit", p)).not.toBe(hash);
  });

  test("rejects invalid scripts, unknown grants/extra keys, malformed history and duplicate inputs", async () => {
    const m = base();
    const p = policy();
    m.script = { ...p, approvedHash: await scriptApprovalHash(m.command, p) };
    expect(validateScriptMacro({ ...m, command: "  " }).ok).toBe(false);
    expect(validateScriptMacro({ ...m, command: "x".repeat(32769) }).ok).toBe(false);
    expect(validateScriptMacro({ ...m, script: { ...m.script, inputs: [...p.inputs, p.inputs[0] ?? { name: "target", type: "token" }] } }).ok).toBe(false);
    expect(validateScriptMacro({ ...m, script: { ...m.script, grants: ["totally-untrusted"] as never } }).ok).toBe(false);
    expect(validateScriptMacro({ ...m, script: { ...m.script, source: "hidden" } as never }).ok).toBe(false);
    expect(validateScriptMacro({ ...m, scriptState: { recent: [{ key: "x", at: 2, revision: "fake" }] } }).ok).toBe(false);
    expect(validateScriptMacro({ ...m, scriptState: { recent: [] } }).ok).toBe(true);
  });

  test("player-callable prefab scripts pin an exact GM-reviewed template allowlist", async () => {
    const m = base();
    const p: Omit<ScriptPolicy, "approvedHash"> = { ...policy(),
      grants: ["prefabs.place"], prefabIds: ["gate-v2"], runAs: "gm" };
    m.script = { ...p, approvedHash: await scriptApprovalHash(m.command, p) };
    expect(validateScriptMacro(m).ok).toBe(true);
    expect(await scriptApprovalHash(m.command, { ...p, prefabIds: ["other"] })).not.toBe(m.script.approvedHash);
    expect(validateScriptMacro({ ...m, script: { ...m.script, runAs: "caller" } }).ok).toBe(false);
    expect(validateScriptMacro({ ...m, script: { ...m.script, prefabIds: [] } }).ok).toBe(false);
    expect(validateScriptMacro({ ...m, script: { ...m.script, prefabIds: ["gate-v2", "gate-v2"] } }).ok).toBe(false);
  });

  test("reviewed summon grants pin exact presets and reject elevated player scripts without an allowlist", async () => {
    const m = base();
    const p: Omit<ScriptPolicy, "approvedHash"> = { ...policy(), grants: ["summons"],
      summonIds: ["wolf-v2"], runAs: "gm" };
    m.script = { ...p, approvedHash: await scriptApprovalHash(m.command, p) };
    expect(validateScriptMacro(m).ok).toBe(true);
    expect(await scriptApprovalHash(m.command, { ...p, summonIds: ["other"] }))
      .not.toBe(m.script.approvedHash);
    expect(validateScriptMacro({ ...m, script: { ...m.script, summonIds: [] } }).ok).toBe(false);
    expect(validateScriptMacro({ ...m, script: { ...m.script, summonIds: ["wolf-v2", "wolf-v2"] } }).ok).toBe(false);
    expect(validateScriptMacro({ ...m, script: { ...m.script, summonIds: ["../wolf"] } }).ok).toBe(false);
    const callerPolicy: Omit<ScriptPolicy, "approvedHash"> = { ...policy(), grants: ["summons"],
      runAs: "caller" };
    m.script = { ...callerPolicy, approvedHash: await scriptApprovalHash(m.command, callerPolicy) };
    expect(validateScriptMacro(m).ok).toBe(true); // normal published-preset rules still apply at the host
  });

  test("only declared typed values and live visible token IDs are accepted", async () => {
    const m = base();
    const p = policy();
    m.script = { ...p, approvedHash: await scriptApprovalHash(m.command, p) };
    const visible = (id: string) => id === "t-visible";
    expect(validateScriptArgs({ tag: "door-1", source: "t-visible" }, m.script, visible)).toEqual({
      ok: true, args: { tag: "door-1", source: "t-visible" },
    });
    expect(validateScriptArgs({ tag: "door-1", source: "hidden" }, m.script, visible).ok).toBe(false);
    expect(validateScriptArgs({ tag: "door-1", admin: true }, m.script, visible).ok).toBe(false);
    expect(validateScriptArgs({ tag: "x".repeat(257) }, m.script, visible).ok).toBe(false);
    expect(validateScriptArgs({ tag: 123 }, m.script, visible).ok).toBe(false);
    expect(validateScriptArgs({}, m.script, visible).ok).toBe(false);
    expect(validateScriptArgs({ tag: "ok", __proto__: { gm: true } }, m.script, visible).ok).toBe(true); // literal prototype is not an own key
  });

  test("RPC/result payloads are bounded finite plain JSON, not circular or executable objects", () => {
    expect(boundedJson({ refs: [{ id: "t1" }], total: 4 })).toBe(true);
    expect(boundedJson({ value: Infinity })).toBe(false);
    expect(boundedJson({ action: () => 42 })).toBe(false);
    expect(boundedJson({ payload: "x".repeat(20000) })).toBe(false);
    const loop: { loop?: object } = {};
    loop.loop = loop;
    expect(boundedJson(loop)).toBe(false);
  });
});
