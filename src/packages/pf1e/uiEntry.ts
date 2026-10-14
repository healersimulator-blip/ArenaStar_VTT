/**
 * Bundle entry for `systems/pf1e-mass-battles/ui.js` (D-475): the components this package
 * contributes to the shells' windows. Built by `scripts/buildSystemPackages.mjs` with the Svelte
 * runtime externalised to the shell's own copy (`globalThis.__ARENASTAR_SVELTE__`), so a package
 * component shares reactivity, context and the DOM scheduler with the shell that mounts it.
 */
import BattleAnalysis from "./ui/BattleAnalysis.svelte";

const ui = {
  api: "arena.ui/1",
  components: {
    /** The army window's Battle Analysis tab, over the turn report's per-army analytics sheet. */
    battleAnalysis: BattleAnalysis,
  },
};

export { ui as default };
