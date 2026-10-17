import { readFileSync } from "node:fs";
import vm from "node:vm";
import { expect, test, vi } from "vitest";

test("native Wizard binding follows effect origin, disable/removal, and author branches without rules code", async () => {
  const realm = vm.createContext({});
  vm.runInContext(readFileSync("modules/ais-foundry-v13/runtime/native-fx.js", "utf8"), realm);
  const source = { id: "caster" }, target = { id: "target", documentName: "Actor" };
  const item = { id: "spell", name: "Any Spell", documentName: "Item", parent: source };
  const effect = { uuid: "Actor.target.ActiveEffect.effect", origin: "Actor.caster.Item.spell", parent: target, disabled: false };
  const macro = { id: "cue", kind: "sequence", fxItem: { actorId: source.id, itemId: item.id, enabled: true, recognition: "auto", onFailureId: "failure" } };
  const hooks = new Map<string, (effect: object) => Promise<unknown>>();
  const play = vi.fn(async () => ({ runId: "owned-run" })), stop = vi.fn(async () => ({ stopped: true }));
  const errors: unknown[] = [];
  const bridge = realm.__aisFoundryNativeFx.install({ AIS: { fx: { play, stop } }, Hooks: { on: (name: string, cb: (e: object) => Promise<unknown>) => hooks.set(name, cb) },
    game: { macros: { contents: [macro] }, actors: { contents: [] } }, fromUuid: async () => item,
    scene: () => ({ tokens: [{ id: "source-token", actor: source }, { id: "target-token", actor: target }] }), reportError: (error: unknown) => errors.push(error) }) as { idle(): Promise<void>; describe(): { effects: number } };
  await hooks.get("createActiveEffect")?.(effect);
  expect(play).toHaveBeenCalledWith({ macroId: "cue", sourceTokenId: "source-token", targetTokenId: "target-token" });
  expect(bridge.describe().effects).toBe(1);
  effect.disabled = true;
  await hooks.get("updateActiveEffect")?.(effect);
  expect(stop).toHaveBeenCalledWith("owned-run");
  expect(bridge.describe().effects).toBe(0);
  effect.disabled = false; macro.fxItem.recognition = "failure";
  await hooks.get("createActiveEffect")?.(effect);
  expect(play).toHaveBeenLastCalledWith({ macroId: "failure", sourceTokenId: "source-token", targetTokenId: "target-token" });
  await hooks.get("deleteActiveEffect")?.(effect);
  expect(bridge.describe().effects).toBe(0);
  await hooks.get("createActiveEffect")?.({ ...effect, origin: undefined });
  expect(play).toHaveBeenCalledTimes(2);
  expect(errors).toEqual([]);
});
