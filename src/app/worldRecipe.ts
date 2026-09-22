/**
 * D-249 — create a world from a *recipe*: name + strategic ruleset + content packs, all
 * written before the first boot. This is what the New-world wizard runs, and it is the
 * reason the wizard needs no "activate, then reload" step: the §12 package rows and the
 * `activeRulesPackage` pin land in the same breath as the `worlds` row, so the very first
 * `bootHostApp({ worldId })` already hands the package's `rules.js` to the SimWorker (the
 * fresh-campaign guard never comes into play — there is no campaign yet).
 *
 * Scope, stated once: the ruleset drives strategic-scale scenes (heroes + units). Tactical
 * scenes (heroes only) use the in-bundle hero rules whatever the recipe says; the new world's
 * first scene is tactical like every seeded scene, and the GM flips scenes under Settings →
 * Scale. A recipe therefore never makes a world "strategic" — it decides which rules the
 * strategic scenes will run when the GM makes some.
 */
import type { IDBPDatabase } from "idb";
import type { PackageManifest } from "../core/packageManifest";
import type { WorldId } from "../core/ids";
import { readZipPackage, type LoadedPackage } from "../packages/packageLoader";
import { putPackage, type PackageRecord } from "../storage/idb";
import { clearParsedPackCache } from "../core/compendiumCache";
import { HostPersister } from "../storage/persistence";
import { BUILTIN_SYSTEM_ID, BUILTIN_SYSTEM_VERSION } from "./hostBoot";
import { packageKindLabel } from "../host/zipKind";

/** A package the wizard has already sniffed and validated (bytes kept for nothing — text only). */
export type RecipePackage = LoadedPackage;

export type RecipeRuleset = { kind: "builtin" } | { kind: "package"; pkg: RecipePackage };

export interface WorldRecipe {
  name: string;
  ruleset: RecipeRuleset;
  /** Content packs (`type: "data"`) installed alongside; order is irrelevant. */
  content: RecipePackage[];
}

export interface RecipeResult {
  worldId: WorldId;
  /** Advisory notes (declared companions missing) — never a refusal, D-110. */
  warnings: string[];
}

export interface RecipeOptions {
  db: IDBPDatabase;
  now?: () => number;
  /** Test seam; default `w-<random>`. */
  worldId?: WorldId;
}

/** Read a zip for a recipe slot; the caller decides which slot from `manifest.type`. */
export async function loadRecipePackage(
  bytes: Uint8Array,
): Promise<{ ok: true; pkg: RecipePackage } | { ok: false; error: string }> {
  const loaded = await readZipPackage(bytes);
  return loaded.ok ? { ok: true, pkg: loaded.value } : { ok: false, error: loaded.error };
}

/** What the wizard shows for a loaded package. */
export function describeRecipePackage(pkg: RecipePackage): {
  id: string;
  name: string;
  version: string;
  kind: string;
  packCount: number;
  modelColumns: string[];
  dependencies: string[];
} {
  const m = pkg.manifest;
  return {
    id: m.id,
    name: m.name,
    version: m.version,
    kind: packageKindLabel(m.type),
    packCount: m.packs?.length ?? 0,
    modelColumns: Object.keys(m.rules?.modelColumns ?? {}),
    dependencies: m.dependencies ?? [],
  };
}

/**
 * Validate a recipe without touching the database. Returns the human reasons a recipe cannot
 * be created (empty = fine) and the advisory warnings that would accompany creation.
 */
export function checkRecipe(recipe: WorldRecipe): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (recipe.name.trim().length === 0) errors.push("the world needs a name");
  const ids = new Set<string>();
  const all: PackageManifest[] = [];
  if (recipe.ruleset.kind === "package") {
    const m = recipe.ruleset.pkg.manifest;
    if (m.type !== "system" || !m.rules) {
      errors.push(`${m.name} is a ${packageKindLabel(m.type)}, not a strategic ruleset`);
    }
    all.push(m);
  }
  for (const pkg of recipe.content) {
    const m = pkg.manifest;
    if (m.type !== "data") {
      errors.push(
        `${m.name} is a strategic ruleset — a world runs one ruleset, chosen above, not as content`,
      );
    }
    all.push(m);
  }
  for (const m of all) {
    if (ids.has(m.id)) errors.push(`package ${m.id} is listed twice`);
    ids.add(m.id);
  }
  for (const m of all) {
    const missing = (m.dependencies ?? []).filter((dep) => !ids.has(dep));
    if (missing.length > 0) {
      warnings.push(`${m.name} expects ${missing.join(", ")} alongside it — not added`);
    }
  }
  return { errors, warnings };
}

const recordOf = (pkg: RecipePackage, worldId: WorldId, importedAt: number): PackageRecord => ({
  worldId,
  id: pkg.manifest.id,
  name: pkg.manifest.name,
  version: pkg.manifest.version,
  type: pkg.manifest.type,
  importedAt,
  manifest: pkg.manifest,
  files: pkg.files,
});

/**
 * Create the world. The `worlds` row is written through `HostPersister` (D-110: the only
 * sanctioned writer of that row) and the packages through `putPackage`, all before anyone
 * boots the world; the persister is closed again at once — nothing is attached to it.
 */
export async function createWorldFromRecipe(
  recipe: WorldRecipe,
  options: RecipeOptions,
): Promise<RecipeResult> {
  const check = checkRecipe(recipe);
  if (check.errors.length > 0) throw new Error(`new world: ${check.errors.join("; ")}`);
  const now = options.now ?? (() => Date.now());
  const worldId: WorldId = options.worldId ?? `w-${globalThis.crypto.randomUUID().slice(0, 8)}`;
  const ruleset = recipe.ruleset.kind === "package" ? recipe.ruleset.pkg : null;

  const persister = await HostPersister.createWorld(
    options.db,
    {
      worldId,
      name: recipe.name.trim(),
      system: ruleset?.manifest.id ?? BUILTIN_SYSTEM_ID,
      systemVersion: ruleset?.manifest.version ?? BUILTIN_SYSTEM_VERSION,
    },
    { now },
  );
  try {
    const stamp = now();
    for (const pkg of recipe.content) await putPackage(options.db, recordOf(pkg, worldId, stamp));
    // Seed writes invalidate the parsed-pack memo (G-45): the world may be seeded more than once
    // in a session, and a stale parse is indistinguishable from a wrong pack.
    clearParsedPackCache();
    if (ruleset) {
      await putPackage(options.db, recordOf(ruleset, worldId, stamp));
      // The pin: what hostBoot reads to pick the SimWorker's rules module. `version` is the
      // migration baseline (D-091), exactly as `HostPackages.activate` sets it.
      await persister.patchWorld({
        activeRulesPackage: ruleset.manifest.id,
        system: ruleset.manifest.id,
        version: ruleset.manifest.version,
      });
    }
  } finally {
    await persister.close();
  }
  return { worldId, warnings: check.warnings };
}
