/**
 * §12 package manifest — the manifest.json contract every rules/data
 * package zip carries. Data-only packages (`type: "data"`) declare packs and
 * no code; script packages (`type: "system"`) additionally declare a single
 * self-contained ESM rules entry (D-086 blob-URL import inside the SimWorker)
 * plus the ModelPool sys columns the host must build the pool with.
 */
import type { ModelColumnType } from "./strategic";
import type { MigrationStep } from "./migrations";
import { validateMigrationSteps } from "./migrations";
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
  type: "system" | "data";
  description?: string;
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
  if (type !== "system" && type !== "data") {
    return err(`package ${id}: manifest.type must be "system" or "data"`);
  }
  if (description !== undefined && typeof description !== "string") {
    return err(`package ${id}: manifest.description must be a string`);
  }
  const manifest: PackageManifest = { id, name, version, type };
  if (description !== undefined) manifest.description = description;

  if (type === "data") {
    if (rules !== undefined) {
      return err(`package ${id}: data-only packages must not declare a rules block`);
    }
    if ((raw as Record<string, unknown>).module !== undefined) {
      return err(`package ${id}: data-only packages must not declare a module block`);
    }
  } else {
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
