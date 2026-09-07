/**
 * src/dice barrel (§18, §11): the Foundry-compatible formula engine.
 * Roll execution on the host (chat rolls) and inside the SimWorker (bulk,
 * seeded) both use this module — never Math.random directly.
 */
export {
  evaluateFormula,
  substituteData,
  validateFormula,
  type RngFn,
  type RollEvaluation,
} from "./engine";
