/**
 * D-468: the GM-side builder of the `ais.profile` message — the set of approved AIS modules a
 * player shell may run. Pure so the sharing policy is testable without a host or an iframe.
 *
 * Policy (in order):
 *   1. only modules in the frozen boot set (world-profile lock + exact-hash local approval);
 *   2. never appearance-only packages (themes stay a local-GM activation, D-456) and never
 *      bare runtime providers (they are dependencies, not programs);
 *   3. never a module the host could not start itself (`blockedReason`);
 *   4. never a module whose consent is not *currently* active on the GM device (the same check
 *      the GM runtime makes before every RPC — a revoked grant stops delivery too);
 *   5. the GM's per-module opt-out (`sharedWithPlayers === false`);
 *   6. (D-469) never a module whose manifest says `sharing: "host-only"` — the author's call,
 *      typically because the module writes in reaction to observed events and must act once.
 *
 * Capabilities travel as the host's grant restricted to the player-runnable subset: a player
 * shell has no FX service, no scene-tag authority and no theme slot, so advertising those
 * would only make the module fail later. Every op a player module produces is still an
 * ordinary intent authorized by the host (`validateOps` + Foundry-default ownership).
 */
import type { AisCapability } from "../core/automationInterconnect";
import { cloneAisSettingDeclaration } from "../core/automationInterconnect";
import type { AisProfileMsg, AisSharedModule } from "../core/messages";
import { packAisSharedModule } from "../core/aisSharedModule";
import type { HostAutomationBoot, HostAutomationModuleBoot } from "./hostBoot";

export type AisProviderSelections = HostAutomationBoot["resolution"]["providers"];

/** Host-device services a player shell cannot provide in P1 (see AIS_PLAYER_RUNTIME_PLAN.md). */
export const GM_DEVICE_ONLY_CAPABILITIES: ReadonlySet<AisCapability> = new Set<AisCapability>([
  "fx.play",
  "scene.tags.write",
  "ui.theme",
  // D-477: compendium packs are host-side package records, never replicated to players.
  "compendium.read",
]);

export function playerRunnableCapabilities(capabilities: readonly AisCapability[]): AisCapability[] {
  return capabilities.filter((capability) => !GM_DEVICE_ONLY_CAPABILITIES.has(capability));
}

export interface AisPlayerProfileInput {
  /** The frozen boot set (`HostApp.automationBoot.modules`). */
  modules: readonly HostAutomationModuleBoot[];
  /** Current exclusive-slot selections (`resolution.providers`, refreshed on every package change). */
  providers: AisProviderSelections;
  /** Throws when the module's GM-device consent is not currently active (see assertAisModuleConsent). */
  assertConsent: (module: HostAutomationModuleBoot) => void;
  /**
   * The GM's *live* sharing decision (`WorldsRecord.automationSharing`); the boot set's
   * `sharedWithPlayers` is a snapshot and un-sharing must take effect without a reload.
   * Defaults to the snapshot.
   */
  isShared?: (packageId: string) => boolean;
}

/** Is this boot module one the GM shares with players under the policy above? */
export function isPlayerSharedModule(
  module: HostAutomationModuleBoot,
  assertConsent: (module: HostAutomationModuleBoot) => void,
  isShared: (packageId: string) => boolean = (id) => module.packageId !== id || module.sharedWithPlayers !== false,
): boolean {
  if (module.appearance || module.runtimeProvider || module.blockedReason || module.hostOnly) return false;
  if (!isShared(module.packageId)) return false;
  try { assertConsent(module); } catch { return false; }
  return true;
}

export function sharedModuleOf(module: HostAutomationModuleBoot): AisSharedModule {
  return {
    packageId: module.packageId,
    name: module.name,
    version: module.version,
    hash: module.hash,
    source: module.source,
    ...(module.resources && Object.keys(module.resources).length > 0 ? { resources: module.resources } : {}),
    ...(module.runtimeHash ? { runtimeHash: module.runtimeHash } : {}),
    ...(module.runtimeContext !== undefined ? { runtimeContext: module.runtimeContext } : {}),
    commands: module.commands.map((command) => ({ ...command })),
    capabilities: playerRunnableCapabilities(module.capabilities.filter((capability) =>
      (module.runtimeDependencies ?? []).every((dependency) => dependency.capabilities.includes(capability)))),
    emittedEvents: [...module.emittedEvents],
    ...(module.tokenActions && module.tokenActions.length > 0 ? { tokenActions: module.tokenActions.map((action) => ({ ...action })) } : {}),
    ...(module.panel ? { panel: { ...module.panel } } : {}),
    ...(module.settings && module.settings.length > 0 ? { settings: module.settings.map((declaration) => cloneAisSettingDeclaration(declaration)) } : {}),
    ...(module.requires && module.requires.length > 0 ? { requires: module.requires.map((requirement) => ({ ...requirement })) } : {}),
    ...(module.provides && module.provides.length > 0 ? { provides: module.provides.map((slot) => ({ ...slot })) } : {}),
  };
}

/** The message body (the host adds `kind`, `worldId` and `seq`). */
export function buildAisPlayerProfile(input: AisPlayerProfileInput): Omit<AisProfileMsg, "kind" | "seq" | "worldId"> {
  const modules = input.modules
    .filter((module) => isPlayerSharedModule(module, input.assertConsent, input.isShared ?? ((id) =>
      input.modules.find((candidate) => candidate.packageId === id)?.sharedWithPlayers !== false)))
    .map(sharedModuleOf);
  const shared = new Set(modules.map((module) => module.packageId));
  const providers: Record<string, string> = {};
  for (const provider of input.providers) {
    // A selection only means something to a player when the selected provider travels too.
    const packageId = provider.selected?.split("/", 1)[0];
    if (provider.selected && packageId && shared.has(packageId)) providers[provider.slotId] = provider.selected;
  }
  // D-487: heavy payloads (a Foundry adapter composition is ≈312 KiB raw) deflate before the
  // wire — one WebRTC user message caps at 256 KiB. Small modules keep the plain fields.
  return { providers, modules: modules.map((module) => packAisSharedModule(module)) };
}
