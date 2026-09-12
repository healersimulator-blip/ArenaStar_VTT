/**
 * P06/D-186 — the world option that decides who resolves the table's attacks of
 * opportunity: the app (default) or the GM by hand.
 *
 * It lives in the replicated `settings` document (`core/worldSettings.ts`) for the same
 * reason the world clock does: what happens when somebody leaves a threatened square is a
 * fact both sides of the table need, and a GM-only local preference would let a player's
 * client disagree with the host about whether an attack already happened.
 *
 * **Default: on.** The setting is read as "on unless the world explicitly says off"
 * (`!== false`), the same polarity `advanceClockOnRoundOf` uses — so a world that has never
 * touched this option auto-resolves, which is what the option is for, and turning it off is
 * an explicit act that survives round-trips (`false` is a scalar the settings validator
 * accepts, and `worldSettingsOps` writes it as its own dotted path). A non-boolean value is
 * not a decision either: it reads as the default rather than silently disabling the feature.
 *
 * Off does not mean "no attacks of opportunity": the queue is still built by
 * `tacticalOpportunity.ts` and its lines are still reported (D-185). Off means the table
 * resolves them instead of the app — the GM rolls and spends.
 */

/** The key under `settings.system`. */
export const PF1E_AUTO_RESOLVE_AOOS_KEY = "autoResolveAoos";

/** The settings bag, as far as this option cares (the whole bag satisfies it). */
export interface AutoResolveAooSettings {
  autoResolveAoos?: unknown;
}

/**
 * Should the app resolve queued attacks of opportunity itself? True unless the world
 * explicitly disabled it.
 */
export function autoResolveAoosOf(settings: AutoResolveAooSettings): boolean {
  return settings.autoResolveAoos !== false;
}

/** True when the world has an explicit value (for a settings UI that wants to say so). */
export function autoResolveAoosIsAuthored(
  settings: AutoResolveAooSettings,
): boolean {
  return typeof settings.autoResolveAoos === "boolean";
}
