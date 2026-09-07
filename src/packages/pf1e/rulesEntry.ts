/**
 * Bundle entry for `systems/pf1e-mass-battles/rules.js` (§12, Gap List §1.1).
 *
 * `scripts/buildSystemPackages.mjs` bundles THIS file with vite/rolldown into one
 * self-contained ESM source text (D-086: the SimWorker resolves no bare imports — it imports a
 * single blob-URL module) and rewrites the tail into the single-expression
 * `export default (() => { … })();` form, which is also what `evalRulesModule` accepts for
 * engines whose classic workers cannot import module scripts (WebKit).
 *
 * `export { rules as default }` (rather than `export default …`) is deliberate: it keeps the
 * local name visible to the rewrite step.
 */
import { createMassBattlePf1e } from "../massBattlePf1e";

const rules = createMassBattlePf1e();

export { rules as default };
