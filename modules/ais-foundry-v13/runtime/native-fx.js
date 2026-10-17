/* ArenaStar-authored interop: native wizard bindings follow real Foundry ActiveEffects.
 * No system rules, condition names, save formulas or damage calculations live here.
 */
(function () {
  "use strict";
  globalThis.__aisFoundryNativeFx = { install({ AIS, Hooks, game, fromUuid, scene, reportError }) {
    const runs = new Map();
    let tail = Promise.resolve();
    const keyFor = name => name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    const enqueue = job => { tail = tail.then(job).catch(error => reportError(error)); return tail; };
    const tokenFor = actor => scene()?.tokens?.find(token => token.actor?.id === actor?.id && !token.hidden);
    const stop = async key => {
      const ids = runs.get(key);
      if (!ids) return;
      for (const id of ids) await AIS.fx.stop(id);
      runs.delete(key);
    };
    const start = async effect => {
      await stop(effect.uuid);
      if (effect.disabled || !effect.parent || effect.parent.documentName !== "Actor") return;
      const origin = effect.getFlag?.("ais-foundry", "itemUuid") ?? effect.origin ?? effect._source?.origin;
      if (!origin) return;
      const item = await fromUuid(origin);
      if (!item || item.documentName !== "Item" || !item.parent) return;
      const source = tokenFor(item.parent), target = tokenFor(effect.parent);
      if (!source || !target) return; // Never manufacture a location or reveal hidden anchors.
      const cues = game.macros.contents.filter(macro => {
        const b = macro.fxItem, s = macro.fxSpell;
        return macro.kind === "sequence" && ((b?.enabled !== false && b?.actorId === item.parent.id && b?.itemId === item.id && (!b.events || b.events.includes("use"))) ||
          (s?.enabled !== false && s?.spellId === keyFor(item.name)));
      });
      // A committed ActiveEffect is an actual success, but honor the author's
      // explicit recognition override and failure branch just like native uses.
      for (const macro of cues.sort((a, b) => a.id.localeCompare(b.id)).slice(0, 1)) {
        const binding = macro.fxItem?.actorId === item.parent.id && macro.fxItem?.itemId === item.id ? macro.fxItem : macro.fxSpell;
        const macroId = binding?.recognition === "failure" ? binding.onFailureId : macro.id;
        if (!macroId) continue;
        const run = await AIS.fx.play({ macroId, sourceTokenId: source.id, targetTokenId: target.id });
        const owned = runs.get(effect.uuid) ?? [];
        owned.push(run.runId); runs.set(effect.uuid, owned);
      }
    };
    Hooks.on("createActiveEffect", effect => enqueue(() => start(effect)));
    Hooks.on("updateActiveEffect", effect => enqueue(() => start(effect)));
    Hooks.on("deleteActiveEffect", effect => enqueue(() => stop(effect.uuid)));
    return {
      idle: () => tail,
      describe: () => ({ effects: runs.size, runs: [...runs.entries()].map(([effect, runIds]) => ({ effect, runIds: [...runIds] })) }),
      restore: () => enqueue(async () => { for (const actor of game.actors.contents) for (const effect of actor.effects) await start(effect); }),
    };
  } };
})();
