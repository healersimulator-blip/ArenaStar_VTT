/**
 * §12 package manifest — the manifest.json contract for system, data and AIS module ZIPs.
 * Data packages declare packs and no code; system packages provide the strategic rules entry;
 * independent `type: "module"` packages use the versioned AIS interconnect contract.
 */
import type { ModelColumnType } from "./strategic";
import type { MigrationStep } from "./migrations";
import { validateMigrationSteps } from "./migrations";
import {
  AIS_API_VERSION,
  AIS_CAPABILITIES,
  AIS_CONTRIBUTION_MODES,
  type AisCapability,
  type AisContributionDeclaration,
  type AisInterconnectManifest,
  type AisModuleCommandDeclaration,
  type AisModuleSharing,
  type AisPanelDeclaration,
  type AisTokenActionDeclaration,
  type AisPackageRequirement,
} from "./automationInterconnect";
import type { Result } from "./result";
import { err, okVal } from "./result";

/** §4A sys column element types (mirror of pool COLUMN_CTORS / rulesLoader). */
export const PACKAGE_COLUMN_TYPES: readonly ModelColumnType[] = [
  "f32",
  "f64",
  "i32",
  "u32",
  "i16",
  "u16",
  "i8",
  "u8",
];

/** Script-package rules block. */
export interface PackageRulesBlock {
  /** Single self-contained ESM file inside the package (D-086 constraint). */
  entry: string;
  /** ModelPool sys columns — must match the module's schema.modelColumns. */
  modelColumns: Record<string, ModelColumnType>;
}

/** Iframe module block: classic script run in the §12 sandboxed iframe. */
export interface PackageModuleBlock {
  entry: string;
  /**
   * §12 trusted in-page execution REQUEST: the package asks to run its
   * module in the host page. The GM must grant trust per world; ungranted
   * packages stay in the sandboxed iframe.
   */
  trusted?: boolean;
}

/** Data pack descriptor (compendium packs land with the §12 compendia unit). */
export interface PackagePack {
  name: string;
  type: string;
  file: string;
}

export interface PackageManifest {
  /** Lowercase slug, unique per world. */
  id: string;
  name: string;
  /** Semver-ish. */
  version: string;
  type: "system" | "data" | "module";
  description?: string;
  /** Independent AIS v1 entry point for `type: "module"` packages. */
  interconnect?: AisInterconnectManifest;
  /**
   * Package ids this one expects alongside it (e.g. a strategic ruleset naming its content
   * pack). Advisory, never enforced (D-110: a system package must stay loadable alone) — the
   * host reports the ones that are not imported so the GM can see what is missing.
   */
  dependencies?: string[];
  /** Required for `system`, forbidden for `data`. */
  rules?: PackageRulesBlock;
  /** Optional (system only): classic-script module entry for the sandboxed iframe. */
  module?: PackageModuleBlock;
  /** Optional (system only): declarative schema migrations (§12). */
  migrations?: MigrationStep[];
  packs?: PackagePack[];
}

const ID_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;
const VERSION_RE = /^\d+\.\d+\.\d+(-[A-Za-z0-9.+-]+)?$/;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const AIS_SLOT_RE = /^[a-z0-9][a-z0-9._:-]{1,127}$/;
const hasControlChars = (text: string): boolean => Array.from(text).some((ch) => (ch.codePointAt(0) ?? 0) < 0x20);

function validateInterconnect(value: unknown, id: string): Result<AisInterconnectManifest> {
  if (!isRecord(value)) return err(`package ${id}: interconnect must be an object`);
  const allowed = new Set(["api", "entry", "requires", "provides", "commands", "emits", "capabilities", "runtime", "runtimeProvider", "sharing", "tokenActions", "panel"]);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) return err(`package ${id}: interconnect has unsupported field ${unknown}`);
  if (value.api !== AIS_API_VERSION)
    return err(`package ${id}: interconnect.api must be ${AIS_API_VERSION}`);
  if (typeof value.entry !== "string" || !isSafePackagePath(value.entry))
    return err(`package ${id}: interconnect.entry must be a safe package-relative path`);

  const requires: AisPackageRequirement[] = [];
  if (value.requires !== undefined) {
    if (!Array.isArray(value.requires) || value.requires.length > 128)
      return err(`package ${id}: interconnect.requires must be an array of at most 128 entries`);
    const seen = new Set<string>();
    for (const raw of value.requires) {
      if (!isRecord(raw)) return err(`package ${id}: interconnect requirement must be an object`);
      const keys = Object.keys(raw);
      if (keys.some((key) => !["id", "version", "optional"].includes(key)))
        return err(`package ${id}: interconnect requirement has an unsupported field`);
      if (typeof raw.id !== "string" || !ID_RE.test(raw.id) || raw.id === id)
        return err(`package ${id}: interconnect requirement has an invalid package id`);
      if (seen.has(raw.id)) return err(`package ${id}: duplicate interconnect requirement ${raw.id}`);
      if (raw.version !== undefined && (typeof raw.version !== "string" || !VERSION_RE.test(raw.version)))
        return err(`package ${id}: interconnect requirement ${raw.id} has an invalid exact version`);
      if (raw.optional !== undefined && typeof raw.optional !== "boolean")
        return err(`package ${id}: interconnect requirement ${raw.id} optional must be boolean`);
      seen.add(raw.id);
      requires.push({
        id: raw.id,
        ...(raw.version === undefined ? {} : { version: raw.version as string }),
        ...(raw.optional === undefined ? {} : { optional: raw.optional as boolean }),
      });
    }
  }

  let runtimeProvider: AisInterconnectManifest["runtimeProvider"];
  let runtime: AisInterconnectManifest["runtime"];
  if (value.runtimeProvider !== undefined) {
    const spec = value.runtimeProvider;
    if (!isRecord(spec) || Array.isArray(spec) ||
        Object.keys(spec).some((key) => !["contract", "profiles"].includes(key)) || spec.contract !== 1 ||
        !Array.isArray(spec.profiles) || spec.profiles.length < 1 || spec.profiles.length > 16 ||
        spec.profiles.some((profile) => typeof profile !== "string" || !AIS_SLOT_RE.test(profile)) ||
        new Set(spec.profiles).size !== spec.profiles.length)
      return err(`package ${id}: invalid runtimeProvider contract/profiles`);
    runtimeProvider = { contract: 1, profiles: [...spec.profiles] as string[] };
  }
  if (value.runtime !== undefined) {
    const spec = value.runtime;
    if (runtimeProvider || !isRecord(spec) || Array.isArray(spec) ||
        Object.keys(spec).some((key) => !["provider", "profile", "scripts", "configuration", "resources"].includes(key)) ||
        typeof spec.provider !== "string" || !ID_RE.test(spec.provider) || spec.provider === id ||
        typeof spec.profile !== "string" || !AIS_SLOT_RE.test(spec.profile) ||
        typeof spec.configuration !== "string" || !isSafePackagePath(spec.configuration) ||
        !Array.isArray(spec.scripts) || spec.scripts.length < 1 || spec.scripts.length > 16 ||
        spec.scripts.some((path) => typeof path !== "string" || !isSafePackagePath(path) || path === value.entry) ||
        new Set(spec.scripts).size !== spec.scripts.length)
      return err(`package ${id}: invalid runtime binding`);
    if (!requires.some((dependency) => dependency.id === spec.provider && dependency.version && !dependency.optional))
      return err(`package ${id}: runtime provider needs a required, exact-version dependency`);
    if (spec.resources !== undefined && (!Array.isArray(spec.resources) || spec.resources.length > 64 ||
        spec.resources.some((path) => typeof path !== "string" || !isSafePackagePath(path)) ||
        new Set(spec.resources).size !== spec.resources.length)) return err(`package ${id}: invalid runtime resources`);
    runtime = { provider: spec.provider, profile: spec.profile,
      scripts: [...spec.scripts] as string[], configuration: spec.configuration,
      ...(spec.resources ? { resources: [...spec.resources] as string[] } : {}) };
  }

  const provides: AisContributionDeclaration[] = [];
  if (value.provides !== undefined) {
    if (!Array.isArray(value.provides) || value.provides.length > 128)
      return err(`package ${id}: interconnect.provides must be an array of at most 128 entries`);
    const seen = new Set<string>();
    for (const raw of value.provides) {
      if (!isRecord(raw)) return err(`package ${id}: interconnect contribution must be an object`);
      if (Object.keys(raw).some((key) => !["id", "mode", "contract", "priority"].includes(key)))
        return err(`package ${id}: interconnect contribution has an unsupported field`);
      if (typeof raw.id !== "string" || !AIS_SLOT_RE.test(raw.id))
        return err(`package ${id}: interconnect contribution id is invalid`);
      if (seen.has(raw.id)) return err(`package ${id}: interconnect repeats contribution ${raw.id}`);
      if (!(AIS_CONTRIBUTION_MODES as readonly unknown[]).includes(raw.mode))
        return err(`package ${id}: interconnect contribution ${raw.id} has an invalid mode`);
      if (!Number.isSafeInteger(raw.contract) || Number(raw.contract) < 1)
        return err(`package ${id}: interconnect contribution ${raw.id} needs a positive contract version`);
      if (raw.priority !== undefined &&
          (typeof raw.priority !== "number" || !Number.isFinite(raw.priority) || Math.abs(raw.priority) > 100_000))
        return err(`package ${id}: interconnect contribution ${raw.id} has an invalid priority`);
      seen.add(raw.id);
      provides.push({
        id: raw.id,
        mode: raw.mode as AisContributionDeclaration["mode"],
        contract: Number(raw.contract),
        ...(raw.priority === undefined ? {} : { priority: Number(raw.priority) }),
      });
    }
  }

  const commands: AisModuleCommandDeclaration[] = [];
  if (value.commands !== undefined) {
    if (!Array.isArray(value.commands) || value.commands.length > 128)
      return err(`package ${id}: interconnect.commands must be an array of at most 128 entries`);
    const seen = new Set<string>();
    for (const raw of value.commands) {
      if (!isRecord(raw) || Object.keys(raw).some((key) => !["id", "contract"].includes(key)))
        return err(`package ${id}: interconnect command must contain only id and contract`);
      if (typeof raw.id !== "string" || !AIS_SLOT_RE.test(raw.id))
        return err(`package ${id}: interconnect command id is invalid`);
      if (seen.has(raw.id)) return err(`package ${id}: interconnect repeats command ${raw.id}`);
      if (!Number.isSafeInteger(raw.contract) || Number(raw.contract) < 1 || Number(raw.contract) > 65_535)
        return err(`package ${id}: interconnect command ${raw.id} needs a positive contract version`);
      seen.add(raw.id);
      commands.push({ id: raw.id, contract: Number(raw.contract) });
    }
  }

  const emits: string[] = [];
  if (value.emits !== undefined) {
    if (!Array.isArray(value.emits) || value.emits.length > 128)
      return err(`package ${id}: interconnect.emits must be an array of at most 128 event ids`);
    const seen = new Set<string>();
    for (const raw of value.emits) {
      if (typeof raw !== "string" || !AIS_SLOT_RE.test(raw))
        return err(`package ${id}: interconnect event id is invalid`);
      if (seen.has(raw)) return err(`package ${id}: interconnect repeats emitted event ${raw}`);
      seen.add(raw);
      emits.push(raw);
    }
  }

  const capabilities: AisCapability[] = [];
  if (value.capabilities !== undefined) {
    if (!Array.isArray(value.capabilities) || value.capabilities.length > AIS_CAPABILITIES.length)
      return err(`package ${id}: interconnect.capabilities must be an array`);
    for (const raw of value.capabilities) {
      if (!(AIS_CAPABILITIES as readonly unknown[]).includes(raw))
        return err(`package ${id}: unsupported AIS capability ${String(raw)}`);
      if (!capabilities.includes(raw as AisCapability)) capabilities.push(raw as AisCapability);
    }
  }

  let sharing: AisModuleSharing | undefined;
  if (value.sharing !== undefined) {
    if (value.sharing !== "players" && value.sharing !== "host-only")
      return err(`package ${id}: interconnect.sharing must be "players" or "host-only"`);
    sharing = value.sharing;
  }

  const tokenActions: AisTokenActionDeclaration[] = [];
  if (value.tokenActions !== undefined) {
    if (!Array.isArray(value.tokenActions) || value.tokenActions.length > 16)
      return err(`package ${id}: interconnect.tokenActions must be an array of at most 16 entries`);
    const seen = new Set<string>();
    for (const raw of value.tokenActions) {
      if (!isRecord(raw) || Object.keys(raw).some((key) => !["id", "label"].includes(key)))
        return err(`package ${id}: interconnect token action must contain only id and label`);
      if (typeof raw.id !== "string" || !AIS_SLOT_RE.test(raw.id))
        return err(`package ${id}: interconnect token action id is invalid`);
      if (typeof raw.label !== "string" || raw.label.trim().length === 0 || raw.label.length > 48 || hasControlChars(raw.label))
        return err(`package ${id}: interconnect token action ${raw.id} needs a label of 1–48 printable characters`);
      if (seen.has(raw.id)) return err(`package ${id}: interconnect repeats token action ${raw.id}`);
      seen.add(raw.id);
      tokenActions.push({ id: raw.id, label: raw.label.trim() });
    }
  }
  if (tokenActions.length > 0 && !capabilities.includes("ui.interaction"))
    return err(`package ${id}: interconnect.tokenActions requires the ui.interaction capability`);

  let panel: AisPanelDeclaration | undefined;
  if (value.panel !== undefined) {
    const raw = value.panel;
    if (!isRecord(raw) || Object.keys(raw).some((key) => !["title", "width", "height"].includes(key)))
      return err(`package ${id}: interconnect.panel must contain only title, width and height`);
    if (typeof raw.title !== "string" || raw.title.trim().length === 0 || raw.title.length > 48 || hasControlChars(raw.title))
      return err(`package ${id}: interconnect.panel needs a title of 1–48 printable characters`);
    const dimension = (key: "width" | "height", fallback: number, min: number, max: number): number | null => {
      const v = raw[key];
      if (v === undefined) return fallback;
      return typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : null;
    };
    const width = dimension("width", 360, 240, 960);
    const height = dimension("height", 420, 160, 720);
    if (width === null || height === null)
      return err(`package ${id}: interconnect.panel width must be an integer 240–960 and height 160–720`);
    panel = { title: raw.title.trim(), width, height };
    if (!capabilities.includes("ui.panel"))
      return err(`package ${id}: interconnect.panel requires the ui.panel capability`);
  }

  if (runtime?.resources?.length && !capabilities.includes("package.resources.read"))
    return err(`package ${id}: declared runtime resources require package.resources.read`);
  if ((runtimeProvider || runtime) && !capabilities.includes("runtime.execute"))
    return err(`package ${id}: adapter execution requires the runtime.execute capability marker`);
  if (runtimeProvider && (commands.length || emits.length || provides.length))
    return err(`package ${id}: runtime providers do not expose standalone commands, events or contribution slots`);
  if (emits.length > 0 && !capabilities.includes("event.emit"))
    return err(`package ${id}: interconnect.emits requires the event.emit capability`);

  return okVal({
    api: AIS_API_VERSION,
    entry: value.entry,
    ...(runtimeProvider ? { runtimeProvider } : {}),
    ...(runtime ? { runtime } : {}),
    ...(requires.length ? { requires } : {}),
    ...(provides.length ? { provides } : {}),
    ...(commands.length ? { commands } : {}),
    ...(emits.length ? { emits } : {}),
    ...(capabilities.length ? { capabilities } : {}),
    ...(sharing ? { sharing } : {}),
    ...(tokenActions.length ? { tokenActions } : {}),
    ...(panel ? { panel } : {}),
  });
}

/** Package-internal path: relative, no traversal, sane length, no NULs. */
export function isSafePackagePath(path: string): boolean {
  if (path.length === 0 || path.length > 200 || path.includes("\0")) return false;
  if (path.startsWith("/") || path.includes("\\")) return false;
  if (path.split("/").some((seg) => seg === "" || seg === "." || seg === "..")) return false;
  return true;
}

/** Validate a parsed manifest.json value against the §12 contract. */
export function validatePackageManifest(raw: unknown): Result<PackageManifest> {
  if (!isRecord(raw)) return err("package: manifest.json is not an object");
  const { id, name, version, type, description, rules, packs } = raw;
  if (typeof id !== "string" || !ID_RE.test(id)) {
    return err("package: manifest.id must be a lowercase slug (a-z0-9-, 2-64 chars)");
  }
  if (typeof name !== "string" || name.length === 0 || name.length > 80) {
    return err("package: manifest.name must be 1-80 chars");
  }
  if (typeof version !== "string" || !VERSION_RE.test(version)) {
    return err(`package ${id}: manifest.version must be semver (x.y.z[-tag])`);
  }
  if (type !== "system" && type !== "data" && type !== "module") {
    return err(`package ${id}: manifest.type must be "system", "data", or "module"`);
  }
  if (description !== undefined && typeof description !== "string") {
    return err(`package ${id}: manifest.description must be a string`);
  }
  const manifest: PackageManifest = { id, name, version, type };
  if (description !== undefined) manifest.description = description;

  const rawDeps = (raw as Record<string, unknown>).dependencies;
  if (rawDeps !== undefined) {
    if (!Array.isArray(rawDeps)) return err(`package ${id}: manifest.dependencies must be an array`);
    const deps: string[] = [];
    for (const dep of rawDeps) {
      if (typeof dep !== "string" || !ID_RE.test(dep)) {
        return err(`package ${id}: manifest.dependencies entries must be package ids`);
      }
      if (dep === id) return err(`package ${id}: a package cannot depend on itself`);
      if (!deps.includes(dep)) deps.push(dep);
    }
    manifest.dependencies = deps;
  }

  if (type === "data") {
    if (rules !== undefined) {
      return err(`package ${id}: data-only packages must not declare a rules block`);
    }
    if ((raw as Record<string, unknown>).module !== undefined) {
      return err(`package ${id}: data-only packages must not declare a module block`);
    }
    if (raw.interconnect !== undefined) {
      return err(`package ${id}: data-only packages must not declare interconnect code`);
    }
  } else if (type === "module") {
    if (rules !== undefined) return err(`package ${id}: AIS modules must not declare a rules block`);
    if (raw.module !== undefined) return err(`package ${id}: AIS modules use interconnect, not the legacy module block`);
    if (raw.migrations !== undefined) return err(`package ${id}: AIS module migrations are not supported in v1`);
    const interconnect = validateInterconnect(raw.interconnect, id);
    if (!interconnect.ok) return interconnect;
    manifest.interconnect = interconnect.value;
  } else {
    if (raw.interconnect !== undefined) {
      return err(`package ${id}: system packages cannot declare an independent interconnect entry`);
    }
    if (!isRecord(rules)) return err(`package ${id}: system packages need a rules block`);
    const { entry, modelColumns } = rules;
    if (typeof entry !== "string" || !isSafePackagePath(entry)) {
      return err(`package ${id}: rules.entry must be a safe package-relative path`);
    }
    if (!isRecord(modelColumns)) {
      return err(`package ${id}: rules.modelColumns must be an object`);
    }
    for (const [col, colType] of Object.entries(modelColumns)) {
      if (!PACKAGE_COLUMN_TYPES.includes(colType as ModelColumnType)) {
        return err(
          `package ${id}: rules.modelColumns.${col} has unsupported type ${String(colType)}`,
        );
      }
    }
    manifest.rules = {
      entry,
      modelColumns: modelColumns as Record<string, ModelColumnType>,
    };
    const mod = (rules as Record<string, unknown>).module ?? raw.module;
    if (mod !== undefined) {
      if (!isRecord(mod)) return err(`package ${id}: module block must be an object`);
      const { entry: modEntry, trusted } = mod;
      if (typeof modEntry !== "string" || !isSafePackagePath(modEntry)) {
        return err(`package ${id}: module.entry must be a safe package-relative path`);
      }
      if (trusted !== undefined && typeof trusted !== "boolean") {
        return err(`package ${id}: module.trusted must be a boolean`);
      }
      manifest.module = trusted === undefined ? { entry: modEntry } : { entry: modEntry, trusted };
    }
    const rawMigrations = (raw as Record<string, unknown>).migrations;
    if (rawMigrations !== undefined) {
      const steps = validateMigrationSteps(rawMigrations);
      if (!steps.ok) return steps;
      manifest.migrations = steps.value;
    }
  }

  if (packs !== undefined) {
    if (!Array.isArray(packs)) return err(`package ${id}: manifest.packs must be an array`);
    const list: PackagePack[] = [];
    for (const pack of packs) {
      if (!isRecord(pack)) return err(`package ${id}: pack entries must be objects`);
      const { name: pName, type: pType, file } = pack;
      if (typeof pName !== "string" || pName.length === 0) {
        return err(`package ${id}: pack.name must be non-empty`);
      }
      if (typeof pType !== "string" || pType.length === 0) {
        return err(`package ${id}: pack.type must be non-empty`);
      }
      if (typeof file !== "string" || !isSafePackagePath(file)) {
        return err(`package ${id}: pack.file must be a safe package-relative path`);
      }
      list.push({ name: pName, type: pType, file });
    }
    manifest.packs = list;
  }
  return okVal(manifest);
}
