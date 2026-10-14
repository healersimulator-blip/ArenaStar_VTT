/* ArenaStar command bindings. Tag searches/rule expansion are performed by the ORIGINAL
 * upstream Tagger class, not by our native Tagger-style query implementation. */
(function () {
  "use strict";
  const invoke = (id, callback) => AIS.commands.on(id, (input, context) =>
    FoundryAdapter.invoke(context, () => callback(input, context)));
  const target = (input) => {
    const document = game.canvas.scene.tokens.get(input.tokenId);
    if (!document) throw new Error("Token is outside this visible scene projection");
    return document;
  };
  invoke("info", () => ({ ...FoundryAdapter.info(), realTagger: typeof Tagger.getByTag === "function" }));
  invoke("find", (input) => {
    if (input.allScenes) throw new Error("All-scene search is outside this profile");
    return Tagger.getByTag(input.tags, { matchAny: input.matchAny === true, matchExactly: input.matchExactly === true,
      caseInsensitive: input.caseInsensitive === true }).map((doc) => ({ id: doc.id, name: doc.name, uuid: doc.uuid, tags: Tagger.getTags(doc) }));
  });
  for (const [id, method] of [["set-tags", "setTags"], ["add-tags", "addTags"], ["clear-tags", "clearAllTags"], ["apply-rules", "applyTagRules"]]) {
    invoke(id, async (input) => {
      const doc = target(input);
      await Tagger[method](doc, input.tags);
      return { id: doc.id, tags: Tagger.getTags(doc) };
    });
  }
  invoke("veto-test", async (input) => {
    const id = Hooks.on("preUpdateToken", () => false);
    try { await Tagger.addTags(target(input), ["must-not-commit"]); }
    catch (error) {
      if (error.message !== "Document update vetoed by a pre-hook") throw error;
      return { vetoed: true, message: error.message, tags: Tagger.getTags(target(input)) };
    }
    finally { Hooks.off("preUpdateToken", id); }
    throw new Error("Expected pre-update veto");
  });
  // This explicitly demonstrates our API SUBSTITUTE over the existing native FX engine.
  // It is not a claim that upstream Tagger itself depends on Sequencer.
  invoke("fx-demo", async (input, context) => {
    const doc = target(input);
    const sequence = new Sequence().effect().text("AIS connected").atLocation(doc).name("ais-feasibility")
      .duration(350).fadeIn(50).fadeOut(100).waitUntilFinished(-100)
      .effect().text("Native FX").atLocation(doc).duration(250);
    const run = await sequence.play();
    return { ...run, nativeFx: true,
      activeOwnRuns: (await context.ais.fx.list()).length };
  });
})();
