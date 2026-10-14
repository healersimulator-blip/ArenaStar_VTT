/**
 * The built-in strategic ruleset (`src/packages/massBattleBasic.ts`) — what a world runs when
 * no §12 system package is active. `WorldsRecord.system` is either this id or the active
 * package's id, so the record (and the join welcome that echoes it) always names the ruleset
 * the sim actually boots with. Lives in its own module so `worldRecipe.ts` and `hostBoot.ts`
 * can both import it without a cycle (D-473: hostBoot creates first-party worlds through the
 * recipe).
 */
export const BUILTIN_SYSTEM_ID = "mass-battle-basic";
export const BUILTIN_SYSTEM_VERSION = "1.0.0";
