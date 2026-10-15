/**
 * ArenaStar Automation Interconnect System (AIS) v1 contracts and profile resolver.
 *
 * This module is deliberately pure: package import, UI preview, host boot and world-file
 * validation can all resolve the same profile without executing package code.
 */
import type { DocRef, LightAnimation } from "./documents";
import type { Op } from "./ops";

export const AIS_API_VERSION = "arena.ais/1" as const;
export const AIS_WORLD_FEATURE = "arena.ais/1" as const;
/** Experimental, closed adapter-loading extension; old readers must refuse its archives. */
export const AIS_RUNTIME_FEATURE = "arena.ais.runtime/1" as const;

/** Typed, read-only workflow/event slice supported by the initial AIS runtime. */
export const AIS_EVENTS = [
  "world.snapshot",
  "world.ops.committed",
  /** Post-commit observation when a visible token's carried light changes. */
  "scene.token.light.changed",
  "turn.phase.changed",
  "turn.report.committed",
  /** Host-originated token menu intent, delivered only to the selected light-action provider. */
  "ui.token.action",
  /** Namespaced events emitted by an approved AIS module; visible only to action observers. */
  "module.event",
  /** D-476: one of this module's own declared settings changed (world scope via a commit, device scope locally). */
  "module.settings.changed",
  /** D-483: the user closed this module's own panel from the host chrome (the frame is hidden, not stopped). */
  "ui.panel.closed",
] as const;
export type AisEventName = (typeof AIS_EVENTS)[number];

/**
 * Capability a module needs to subscribe to an event. Host-state events need `action.observe`;
 * a module's own settings carry no host state (D-476), and its own panel is covered by the
 * `ui.panel` grant that made the panel exist (D-483).
 */
export function aisEventSubscriptionCapability(event: AisEventName): AisCapability | null {
  if (event === "module.settings.changed") return null;
  if (event === "ui.panel.closed") return "ui.panel";
  return "action.observe";
}

/** Safe light projection delivered to AIS observers; it contains no token or actor document. */
export interface AisTokenLightSnapshot {
  radius: number;
  bright: number;
  color: string;
  alpha: number;
  angle: number;
  animation?: LightAnimation;
}

export interface AisEventPayloads {
  "world.snapshot": { seq: number };
  "world.ops.committed": { seq: number; operationCount: number };
  "scene.token.light.changed": {
    sceneId: string;
    tokenId: string;
    /** Snapshot after commit; zero radius represents an extinguished source. */
    light: AisTokenLightSnapshot;
  };
  "turn.phase.changed": {
    turnId: string;
    phase: "orders" | "resolution" | "report";
    mode?: "stepwise" | "realtime" | "simultaneous";
    paused?: boolean;
  };
  "turn.report.committed": { turnId: string; turn: number; rulesVersion: string };
  "ui.token.action": {
    sceneId: string;
    tokenId: string;
    /** Versioned UI action IDs are owned by the selected contribution. */
    action: string;
  };
  "module.event": {
    /** Host-authenticated source package; modules cannot spoof this field. */
    packageId: string;
    /** Event name declared by the source package's manifest. */
    eventId: string;
    /** Bounded JSON payload chosen by the source module. */
    payload: import("./documents").Json;
  };
  "module.settings.changed": {
    scope: AisSettingScope;
    key: string;
    /** The effective value after the change (already coerced to the declaration). */
    value: AisSettingValue;
  };
  "ui.panel.closed": {
    /** Only the host chrome's Close button raises this; `ui.panel.close` from the module itself does not. */
    reason: "user";
  };
}

export interface AisTokenLightChangeRef { sceneId: string; tokenId: string }

/** Find committed token-light writes without exposing the operation payload to modules. */
export function aisTokenLightChanges(ops: readonly Op[]): AisTokenLightChangeRef[] {
  const changes = new Map<string, AisTokenLightChangeRef>();
  const sceneIdOf = (start: DocRef | undefined): string | null => {
    let parent = start;
    while (parent) {
      if (parent.coll === "scenes") return parent.id;
      parent = parent.parent;
    }
    return null;
  };
  const add = (sceneId: string | null, tokenId: string): void => {
    if (sceneId) changes.set(JSON.stringify([sceneId, tokenId]), { sceneId, tokenId });
  };
  for (const op of ops) {
    if (op.kind === "create" && op.coll === "tokens") {
      const data = op.data as unknown as { _id: string; light?: unknown };
      if (Object.hasOwn(data, "light")) add(sceneIdOf(op.parent), data._id);
    } else if ((op.kind === "update" || op.kind === "delete") && op.ref.coll === "tokens") {
      if (op.kind === "delete" || Object.keys(op.diff).some((path) =>
        path === "light" || path.startsWith("light.") || path === "-=light" || path.startsWith("-=light."))) {
        add(sceneIdOf(op.ref.parent), op.ref.id);
      }
    }
  }
  return [...changes.values()];
}

export const AIS_CONTRIBUTION_MODES = [
  "observe",
  "augment",
  "transform",
  "exclusive",
  "register",
] as const;
export type AisContributionMode = (typeof AIS_CONTRIBUTION_MODES)[number];

/** Explicit narrow host services; never raw ops, a store handle or arbitrary system writes. */
export const AIS_CAPABILITIES = [
  "scene.read.visible",
  "action.observe",
  "module.storage.read",
  "module.storage.write",
  "chat.post",
  "ui.notify",
  "ui.interaction",
  "event.emit",
  "actor.inventory.read",
  "actor.inventory.consume",
  "scene.token.light.manage",
  "scene.tags.read",
  "scene.tags.write",
  "fx.play",
  // Also a downgrade fence: older kernels reject this unknown capability instead of
  // ignoring runtime metadata in an already-imported shared IndexedDB world.
  "runtime.execute",
  "package.resources.read",
  "ui.theme",
  // D-470: a host-chromed window around the module's own sandboxed document (AIS.ui.panel).
  "ui.panel",
  // D-476: write the module's own declared settings (world scope needs GM authority at the host).
  "module.settings.write",
  // D-477: read-only access to the world's imported compendium packs (index, search, entry payloads).
  "compendium.read",
  // D-478: call a declared command of another running module through the kernel (AIS.modules.invoke).
  "modules.invoke",
] as const;
export type AisCapability = (typeof AIS_CAPABILITIES)[number];

export interface AisContributionDeclaration {
  /** Stable resolver/extension-point ID, e.g. `pf1e.damage.resolve`. */
  id: string;
  mode: AisContributionMode;
  /** Version of the contribution's input/output contract. */
  contract: number;
  /** Optional deterministic order within a compatible reducer. */
  priority?: number;
}

export interface AisPackageRequirement {
  id: string;
  /** Exact package version when the contribution is version-coupled. */
  version?: string;
  optional?: boolean;
}

/** A named entry point which ArenaStar's separately reviewed script macros may call. */
export interface AisModuleCommandDeclaration {
  /** Stable package-local command ID. */
  id: string;
  /** Version of the command payload/result contract. */
  contract: number;
}

export interface AisRuntimeProviderDeclaration {
  contract: 1;
  profiles: string[];
  /** D-483: provider source files evaluated before `entry`, in order (each a safe package path). */
  scripts?: string[];
}

export interface AisRuntimeBinding {
  provider: string;
  profile: string;
  /** Ordered, already-prepared classic-script files, executed after the adapter. */
  scripts: string[];
  /** Package-local JSON configuration. Not executable and never an authority claim. */
  configuration: string;
  /** Explicitly readable package-local UTF-8 resources (CSS, translations, encoded raster assets). */
  resources?: string[];
}

export interface AisInterconnectManifest {
  api: typeof AIS_API_VERSION;
  /** Classic script loaded only in the package's restricted iframe. */
  entry: string;
  /** A provider is reviewed/enabled but only executes as part of an approved guest. */
  runtimeProvider?: AisRuntimeProviderDeclaration;
  runtime?: AisRuntimeBinding;
  requires?: AisPackageRequirement[];
  provides?: AisContributionDeclaration[];
  /** Declared callable module entry points; each callback remains constrained by host capabilities. */
  commands?: AisModuleCommandDeclaration[];
  /** Package-local names permitted in `AIS.events.emit`; the host adds the source package ID. */
  emits?: string[];
  capabilities?: AisCapability[];
  /**
   * D-469: where the module may run. `players` (default) lets the GM share it with player
   * devices (each player consents; the host still authorizes every write); `host-only` keeps it
   * on the GM device — the author's choice for modules that write in reaction to observed events.
   */
  sharing?: AisModuleSharing;
  /**
   * D-469: entries both shells add to a token's context menu while the module runs; choosing
   * one emits `ui.token.action` with `action: id` to this module (the generic form of the
   * token-light slot). At a player they appear only for tokens that player controls.
   */
  tokenActions?: AisTokenActionDeclaration[];
  /**
   * D-470: the module draws its own UI inside its sandboxed iframe document; the shell shows that
   * document in a window it chromes itself (title, origin, close). One panel per module; needs
   * the `ui.panel` capability. The guest opens/closes it with `AIS.ui.panel.open()/close()`.
   */
  panel?: AisPanelDeclaration;
  /**
   * D-476: schema-declared module settings. `world` scope lives in a replicated `settings`
   * document the GM owns (players read it, module writes need `module.settings.write` and GM
   * authority); `device` scope is stored per device/world in IndexedDB. Both shells render the
   * schema as a form; the module reads values with `AIS.settings.*` and observes
   * `module.settings.changed`.
   */
  settings?: AisSettingDeclaration[];
}

export type AisSettingScope = "world" | "device";
export type AisSettingType = "boolean" | "number" | "string" | "choice";
export type AisSettingValue = boolean | number | string;
export interface AisSettingChoice { value: string; label: string }
export interface AisSettingDeclaration {
  /** Package-local key, `^[a-z][a-zA-Z0-9_]{0,47}$`. */
  key: string;
  scope: AisSettingScope;
  type: AisSettingType;
  label: string;
  hint?: string;
  default: AisSettingValue;
  /** Numbers: inclusive bounds and an optional step (integers when step is an integer). */
  min?: number;
  max?: number;
  step?: number;
  /** Strings: maximum length (≤ 16 384, default 256). */
  maxLength?: number;
  /** Choices: 2–32 entries; the value must be one of them. */
  choices?: AisSettingChoice[];
  /**
   * D-482: not shown in the shells' forms (still listed by `settings.list`). The Foundry adapter
   * uses it for `config: false` settings — module-internal state a Foundry module keeps in
   * `game.settings` — which it stores as JSON text in a `string` setting.
   */
  hidden?: boolean;
}
export const AIS_MAX_SETTINGS = 32;
/** D-482: `settings.register` at runtime may add this many declarations on top of the manifest's. */
export const AIS_MAX_RUNTIME_SETTINGS = 64;
export const AIS_MAX_SETTING_CHOICES = 32;

/**
 * A plain copy of one declaration. Shells keep `HostApp`/`PlayerApp` in Svelte `$state`, so a
 * declaration read through the app is a reactive proxy — `structuredClone` and `postMessage`
 * refuse proxies ("#<Object> could not be cloned"), which is exactly how the GM's settings form
 * failed in the browser. Copy field by field instead; the result is always cloneable.
 */
export function cloneAisSettingDeclaration(declaration: AisSettingDeclaration): AisSettingDeclaration {
  return {
    key: declaration.key,
    scope: declaration.scope,
    type: declaration.type,
    label: declaration.label,
    ...(declaration.hint !== undefined ? { hint: declaration.hint } : {}),
    default: declaration.default,
    ...(declaration.min !== undefined ? { min: declaration.min } : {}),
    ...(declaration.max !== undefined ? { max: declaration.max } : {}),
    ...(declaration.step !== undefined ? { step: declaration.step } : {}),
    ...(declaration.maxLength !== undefined ? { maxLength: declaration.maxLength } : {}),
    ...(declaration.choices ? { choices: declaration.choices.map((choice) => ({ value: choice.value, label: choice.label })) } : {}),
    ...(declaration.hidden ? { hidden: true } : {}),
  };
}
export const AIS_MAX_SETTING_STRING = 16_384;

export interface AisPanelDeclaration {
  title: string;
  /** CSS pixels, 240–960 (default 360). */
  width: number;
  /** CSS pixels, 160–720 (default 420). */
  height: number;
}

export type AisModuleSharing = "players" | "host-only";

export interface AisTokenActionDeclaration {
  id: string;
  label: string;
}

export interface AisModuleLock {
  id: string;
  version: string;
  /** SHA-256 of the canonical package file map, including manifest.json. */
  hash: string;
}

export interface AisActivationProfile {
  api: typeof AIS_API_VERSION;
  /** The enabled world profile, locked to the exact imported package bytes. */
  modules: AisModuleLock[];
  /** Slot ID → `packageId/contributionId`; local trust/capability grants are never here. */
  providers: Record<string, string>;
}

export interface AisPackageCandidate {
  id: string;
  version: string;
  hash: string;
  type: "system" | "data" | "module";
  interconnect?: AisInterconnectManifest;
}

export type AisResolutionIssueKind =
  | "missing-module"
  | "not-a-module"
  | "version-mismatch"
  | "hash-mismatch"
  | "missing-dependency"
  | "inactive-dependency"
  | "dependency-cycle"
  | "duplicate-module"
  | "invalid-profile"
  | "provider-conflict"
  | "invalid-provider-selection"
  | "unsupported-capability";

export interface AisResolutionIssue {
  kind: AisResolutionIssueKind;
  message: string;
  packageId?: string;
  slotId?: string;
  blocking: boolean;
}

export interface AisResolvedProvider {
  slotId: string;
  mode: AisContributionMode;
  contract: number;
  providers: string[];
  selected: string | null;
  order: string[];
}

export interface AisResolution {
  /** Enabled packages with matching version/hash and satisfiable package requirements. */
  modules: AisPackageCandidate[];
  /** Deterministic dependency order (package ID breaks otherwise-equal ties). */
  order: string[];
  providers: AisResolvedProvider[];
  issues: AisResolutionIssue[];
}

const ID_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;
const SLOT_RE = /^[a-z0-9][a-z0-9._:-]{1,127}$/;
const HASH_RE = /^[a-f0-9]{64}$/;
const VERSION_RE = /^\d+\.\d+\.\d+(-[A-Za-z0-9.+-]+)?$/;
const providerRef = (packageId: string, contributionId: string): string =>
  `${packageId}/${contributionId}`;

export function isAisCapability(value: unknown): value is AisCapability {
  return (AIS_CAPABILITIES as readonly unknown[]).includes(value);
}

/** Strict profile validation used at package/profile/world-file boundaries. */
export function validateAisActivationProfile(value: unknown):
  | { ok: true; value: AisActivationProfile }
  | { ok: false; error: string } {
  const fail = (error: string) => ({ ok: false as const, error });
  if (!isRecord(value)) return fail("AIS profile must be an object");
  if (Object.keys(value).some((key) => !["api", "modules", "providers"].includes(key)))
    return fail("AIS profile has an unsupported field");
  if (value.api !== AIS_API_VERSION) return fail(`AIS profile api must be ${AIS_API_VERSION}`);
  if (!Array.isArray(value.modules) || value.modules.length > 256)
    return fail("AIS profile modules must be an array of at most 256 entries");
  if (!isRecord(value.providers) || Object.keys(value.providers).length > 256)
    return fail("AIS profile providers must be an object with at most 256 entries");

  const seen = new Set<string>();
  const modules: AisModuleLock[] = [];
  for (const raw of value.modules) {
    if (!isRecord(raw) || Object.keys(raw).some((key) => !["id", "version", "hash"].includes(key)) ||
        typeof raw.id !== "string" || !ID_RE.test(raw.id))
      return fail("AIS profile contains an invalid module lock");
    if (seen.has(raw.id)) return fail(`AIS profile repeats module ${raw.id}`);
    if (typeof raw.version !== "string" || !VERSION_RE.test(raw.version))
      return fail(`AIS profile module ${raw.id} has an invalid version`);
    if (typeof raw.hash !== "string" || !HASH_RE.test(raw.hash))
      return fail(`AIS profile module ${raw.id} has an invalid content hash`);
    seen.add(raw.id);
    modules.push({ id: raw.id, version: raw.version, hash: raw.hash });
  }

  const providers: Record<string, string> = {};
  for (const [slot, provider] of Object.entries(value.providers)) {
    if (!SLOT_RE.test(slot)) return fail(`AIS profile has an invalid provider slot ${slot}`);
    if (typeof provider !== "string" || provider.length > 192)
      return fail(`AIS profile has an invalid selection for ${slot}`);
    const [packageId, contributionId, ...extra] = provider.split("/");
    if (!packageId || !ID_RE.test(packageId) || !contributionId || !SLOT_RE.test(contributionId) || extra.length > 0)
      return fail(`AIS profile has an invalid provider reference for ${slot}`);
    providers[slot] = provider;
  }
  modules.sort((a, b) => a.id.localeCompare(b.id));
  return { ok: true, value: { api: AIS_API_VERSION, modules, providers } };
}

/**
 * Resolve an activation profile without executing any module code. All hard errors are visible
 * to the package manager; exclusive contributions never fall back to load order.
 */
export function resolveAisProfile(
  packages: readonly AisPackageCandidate[],
  profile: AisActivationProfile | undefined,
  activeSystemId: string,
): AisResolution {
  const issues: AisResolutionIssue[] = [];
  const profileResult = profile ? validateAisActivationProfile(profile) : null;
  if (profileResult && !profileResult.ok) {
    issues.push({ kind: "invalid-profile", message: profileResult.error, blocking: true });
  }
  const normalized = profileResult?.ok ? profileResult.value : undefined;
  const available = new Map(packages.map((pkg) => [pkg.id, pkg]));
  const locks = normalized?.modules ?? [];
  const lockById = new Map<string, AisModuleLock>();
  for (const lock of locks) {
    if (lockById.has(lock.id)) {
      issues.push({
        kind: "duplicate-module",
        packageId: lock.id,
        message: `AIS profile repeats module ${lock.id}`,
        blocking: true,
      });
    } else lockById.set(lock.id, lock);
  }

  const eligible = new Map<string, AisPackageCandidate>();
  for (const lock of lockById.values()) {
    const pkg = available.get(lock.id);
    if (!pkg) {
      issues.push({
        kind: "missing-module",
        packageId: lock.id,
        message: `Enabled AIS module ${lock.id} is not imported into this world`,
        blocking: true,
      });
      continue;
    }
    if (pkg.type !== "module" || !pkg.interconnect) {
      issues.push({
        kind: "not-a-module",
        packageId: lock.id,
        message: `Enabled package ${lock.id} is not an AIS module`,
        blocking: true,
      });
      continue;
    }
    if (pkg.version !== lock.version) {
      issues.push({
        kind: "version-mismatch",
        packageId: lock.id,
        message: `${lock.id} is locked to ${lock.version}, but ${pkg.version} is installed`,
        blocking: true,
      });
      continue;
    }
    if (pkg.hash !== lock.hash) {
      issues.push({
        kind: "hash-mismatch",
        packageId: lock.id,
        message: `${lock.id} content differs from the enabled profile; review and enable the new package version`,
        blocking: true,
      });
      continue;
    }
    eligible.set(lock.id, pkg);
  }

  // Missing / incompatible requirements block just the dependent module. Other modules can
  // still boot, matching the design's per-contribution failure-containment rule.
  const blocked = new Set<string>();
  const edges = new Map<string, string[]>();
  for (const [id, pkg] of eligible) {
    const dependencies: string[] = [];
    for (const requirement of pkg.interconnect?.requires ?? []) {
      const dependency = available.get(requirement.id);
      let reason: string | null = null;
      if (!dependency) reason = `required package ${requirement.id} is not imported`;
      else if (requirement.version && dependency.version !== requirement.version)
        reason = `requires ${requirement.id} v${requirement.version}, found v${dependency.version}`;
      else if (dependency.type === "system" && requirement.id !== activeSystemId)
        reason = `requires active system ${requirement.id}`;
      else if (dependency.type === "module" && !eligible.has(requirement.id))
        reason = `requires enabled module ${requirement.id}`;
      if (reason) {
        issues.push({
          kind: !dependency ? "missing-dependency" : "inactive-dependency",
          packageId: id,
          message: `${id} ${requirement.optional ? "optionally " : ""}${reason}`,
          blocking: !requirement.optional,
        });
        if (!requirement.optional) blocked.add(id);
      } else if (dependency?.type === "module") dependencies.push(requirement.id);
    }
    const runtime = pkg.interconnect?.runtime;
    if (runtime) {
      const provider = available.get(runtime.provider);
      if (!provider?.interconnect?.runtimeProvider?.profiles.includes(runtime.profile)) {
        blocked.add(id);
        issues.push({ kind: "inactive-dependency", packageId: id, blocking: true,
          message: `${id} requires runtime profile ${runtime.profile} from ${runtime.provider}` });
      }
    }
    edges.set(id, dependencies);
    for (const capability of pkg.interconnect?.capabilities ?? []) {
      if (!isAisCapability(capability)) {
        blocked.add(id);
        issues.push({
          kind: "unsupported-capability",
          packageId: id,
          message: `${id} requests unsupported capability ${String(capability)}`,
          blocking: true,
        });
      }
    }
  }

  // Deterministic topological sort with cycle reporting. A cyclic component is blocked, while
  // independent modules remain available.
  const order: string[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const cycleMembers = new Set<string>();
  const visit = (id: string, path: string[]): void => {
    if (visited.has(id) || blocked.has(id)) return;
    if (visiting.has(id)) {
      const start = path.indexOf(id);
      for (const member of path.slice(start < 0 ? 0 : start)) cycleMembers.add(member);
      cycleMembers.add(id);
      return;
    }
    visiting.add(id);
    const nextPath = [...path, id];
    for (const dependency of [...(edges.get(id) ?? [])].sort()) visit(dependency, nextPath);
    visiting.delete(id);
    visited.add(id);
    order.push(id);
  };
  for (const id of [...eligible.keys()].sort()) visit(id, []);
  for (const id of cycleMembers) {
    blocked.add(id);
    issues.push({
      kind: "dependency-cycle",
      packageId: id,
      message: `AIS module dependency cycle includes ${id}`,
      blocking: true,
    });
  }
  // A module whose required dependency is blocked cannot run merely because DFS visited it
  // before the cycle/missing-dependency was fully diagnosed. Propagate block state upstream.
  let propagated = true;
  while (propagated) {
    propagated = false;
    for (const [id, dependencies] of edges) {
      if (blocked.has(id)) continue;
      const blockedDependency = dependencies.find((dependency) => blocked.has(dependency));
      if (!blockedDependency) continue;
      blocked.add(id);
      propagated = true;
      issues.push({
        kind: "inactive-dependency",
        packageId: id,
        message: `${id} requires module ${blockedDependency}, which is blocked`,
        blocking: true,
      });
    }
  }
  const orderedIds = order.filter((id) => !blocked.has(id));
  const modules = orderedIds.map((id) => eligible.get(id)).filter(isCandidate);

  const declarations = new Map<string, Array<{
    moduleId: string;
    ref: string;
    declaration: AisContributionDeclaration;
  }>>();
  for (const module of modules) {
    for (const declaration of module.interconnect?.provides ?? []) {
      const values = declarations.get(declaration.id) ?? [];
      values.push({
        moduleId: module.id,
        ref: providerRef(module.id, declaration.id),
        declaration,
      });
      declarations.set(declaration.id, values);
    }
  }

  const providerSelections = normalized?.providers ?? {};
  const resolvedProviders: AisResolvedProvider[] = [];
  for (const [slotId, entries] of [...declarations.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const modes = new Set(entries.map((entry) => entry.declaration.mode));
    const contracts = new Set(entries.map((entry) => entry.declaration.contract));
    const candidates = entries.map((entry) => entry.ref).sort();
    const mode = entries[0]?.declaration.mode ?? "observe";
    const contract = entries[0]?.declaration.contract ?? 0;
    if (modes.size > 1 || contracts.size > 1) {
      issues.push({
        kind: "provider-conflict",
        slotId,
        message: `AIS slot ${slotId} has incompatible contribution modes or contract versions`,
        blocking: true,
      });
      continue;
    }

    let selected: string | null = null;
    let providerOrder = [...entries]
      .sort((a, b) =>
        (a.declaration.priority ?? 0) - (b.declaration.priority ?? 0) ||
        a.moduleId.localeCompare(b.moduleId) ||
        a.ref.localeCompare(b.ref),
      )
      .map((entry) => entry.ref);
    if (mode === "exclusive") {
      const configured = providerSelections[slotId];
      if (configured !== undefined && !candidates.includes(configured)) {
        issues.push({
          kind: "invalid-provider-selection",
          slotId,
          message: `AIS provider selection ${configured} is not an enabled candidate for ${slotId}`,
          blocking: true,
        });
      } else if (configured !== undefined) selected = configured;
      else if (candidates.length === 1) selected = candidates[0] ?? null;
      else {
        issues.push({
          kind: "provider-conflict",
          slotId,
          message: `AIS slot ${slotId} has ${candidates.length} exclusive providers; select one explicitly`,
          blocking: true,
        });
      }
      providerOrder = selected ? [selected] : [];
    } else if (mode === "register" && candidates.length > 1) {
      issues.push({
        kind: "provider-conflict",
        slotId,
        message: `AIS register slot ${slotId} is declared more than once`,
        blocking: true,
      });
      providerOrder = [];
    }
    resolvedProviders.push({
      slotId,
      mode,
      contract,
      providers: candidates,
      selected,
      order: providerOrder,
    });
  }

  for (const [slotId, selected] of Object.entries(providerSelections)) {
    if (!declarations.has(slotId)) {
      issues.push({
        kind: "invalid-provider-selection",
        slotId,
        message: `AIS profile selects ${selected} for missing slot ${slotId}`,
        blocking: true,
      });
    }
  }

  return { modules, order: orderedIds, providers: resolvedProviders, issues };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCandidate(value: AisPackageCandidate | undefined): value is AisPackageCandidate {
  return value !== undefined;
}

export function emptyAisProfile(): AisActivationProfile {
  return { api: AIS_API_VERSION, modules: [], providers: {} };
}

export function withAisModule(
  profile: AisActivationProfile | undefined,
  module: AisModuleLock,
): AisActivationProfile {
  const current = profile ?? emptyAisProfile();
  return {
    api: AIS_API_VERSION,
    modules: [...current.modules.filter((entry) => entry.id !== module.id), module].sort((a, b) =>
      a.id.localeCompare(b.id),
    ),
    providers: { ...current.providers },
  };
}

export function withoutAisModule(
  profile: AisActivationProfile | undefined,
  id: string,
): AisActivationProfile {
  const current = profile ?? emptyAisProfile();
  const modules = current.modules.filter((entry) => entry.id !== id);
  const providers = Object.fromEntries(
    Object.entries(current.providers).filter(([, value]) => !value.startsWith(`${id}/`)),
  );
  return { api: AIS_API_VERSION, modules, providers };
}
