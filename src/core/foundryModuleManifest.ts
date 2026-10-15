/**
 * D-482: Foundry VTT `module.json` → ArenaStar package manifest, so a Foundry-format module
 * distribution imports **unmodified** and runs through the `ais-foundry-v13` adapter's
 * `foundry-module` profile. Pure data: nothing here executes module code.
 *
 * What is mapped
 *   - `id` / `title` / `version` / `description` → package `id` (slugged), `name`, `version`.
 *   - `esmodules[]`, `scripts[]`, `styles[]`, `languages[]`, `packs[]`, `relationships` →
 *     kept verbatim in `module.json`, which becomes the guest's `runtime.configuration`; the
 *     adapter reads them from `runtimeContext.configuration`. Paths are normalised to
 *     package-relative form (`/scripts/x.js`, `./x.js`, `modules/<id>/x.js` → `scripts/x.js`).
 *   - every text file of the distribution → `runtime.resources` (the ESM graph loader and
 *     `game.i18n` read them through `package.resource.read`); binary files are skipped by the
 *     loader and listed in the import summary.
 *
 * What is refused (clear error, nothing imported)
 *   - no `id`, no `esmodules`/`scripts` entry file present as text, more than
 *     {@link FOUNDRY_MAX_TEXT_FILES} text files, or any path escaping the module root.
 *   - **System dependency**: modules that `relationships.systems` on a specific system (e.g.
 *     `pf1`) still import — the adapter runs them with `game.system.id = "arenastar"` and the
 *     module decides; the import summary names the declared systems so the GM knows why a
 *     pf1-only module may do nothing.
 */
import type { Result } from "./result";
import { err, okVal } from "./result";
import { isSafePackagePath, validatePackageManifest, type PackageManifest } from "./packageManifest";
import { AIS_API_VERSION } from "./automationInterconnect";

/** The runtime provider every synthesized Foundry module binds to, exact version. */
export const FOUNDRY_ADAPTER = Object.freeze({ id: "ais-foundry-v13", version: "0.2.0", profile: "foundry-module" });
/** Path under which the synthesized ArenaStar manifest is written into the imported files. */
export const FOUNDRY_SYNTHESIZED_MANIFEST = "manifest.json";
/** Inert stubs the AIS kernel requires (entry + runtime script); the adapter does the loading. */
export const FOUNDRY_ENTRY_STUB_PATH = "ais-foundry/entry.js";
export const FOUNDRY_LOADER_STUB_PATH = "ais-foundry/loader.js";
export const FOUNDRY_MANIFEST_PATH = "module.json";
export const FOUNDRY_MAX_TEXT_FILES = 512;

export interface FoundryLanguage { lang: string; name: string; path: string }
export interface FoundryPack { name: string; label: string; path: string; type: string }

export interface FoundryModuleManifest {
  /** The Foundry id, verbatim (what `game.modules.get(id)` must answer to). */
  id: string;
  title: string;
  /** Foundry version text, verbatim. */
  version: string;
  description: string;
  esmodules: string[];
  scripts: string[];
  styles: string[];
  languages: FoundryLanguage[];
  packs: FoundryPack[];
  /** `relationships.systems[].id` (+ legacy `systems[]`): the systems the module says it needs. */
  systems: string[];
  /** `relationships.requires[].id` (+ legacy `dependencies[].name`). */
  requires: string[];
  compatibility: { minimum: string | null; verified: string | null; maximum: string | null };
  socket: boolean;
  library: boolean;
  /** Remote or otherwise unusable entries that were dropped, for the import summary. */
  dropped: string[];
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const FOUNDRY_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const AIS_ID_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;
const SEMVER_RE = /^\d+\.\d+\.\d+(-[A-Za-z0-9.+-]+)?$/;

/** ArenaStar package id for a Foundry module id (lower-case, `_` → `-`, 2–64 chars). */
export function aisPackageIdForFoundry(foundryId: string): string {
  const slug = foundryId.toLowerCase().replaceAll("_", "-").replace(/-+$/, "");
  const candidate = slug.length < 2 ? `fm-${slug}` : slug;
  return AIS_ID_RE.test(candidate) ? candidate : `fm-${candidate.replace(/[^a-z0-9-]/g, "")}`.slice(0, 64);
}

/** Semver for the manifest; Foundry versions are free text (`1.5.4`, `v2`, `11.11`, placeholders). */
export function aisVersionForFoundry(version: string): string {
  const text = version.trim();
  if (SEMVER_RE.test(text)) return text;
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(text);
  if (!m) return "0.0.0";
  return `${Number(m[1])}.${Number(m[2] ?? 0)}.${Number(m[3] ?? 0)}`;
}

/**
 * Foundry path → package-relative path, or null when it cannot be served from the zip
 * (remote URL, traversal, another package's tree). Accepted spellings: `scripts/x.js`,
 * `/scripts/x.js`, `./scripts/x.js`, `modules/<id>/scripts/x.js`, `/modules/<id>/scripts/x.js`.
 */
export function normalizeFoundryPath(path: string, moduleId: string): string | null {
  let p = path.trim().replaceAll("\\", "/");
  if (p === "" || /^[a-z][a-z0-9+.-]*:/i.test(p)) return null;
  p = p.replace(/\/{2,}/g, "/");
  while (p.includes("/./")) p = p.replaceAll("/./", "/");
  const stripLeading = (text: string): string => text.replace(/^(\.\/|\/)+/, "");
  p = stripLeading(p);
  const prefix = `modules/${moduleId}/`;
  if (p.startsWith(prefix)) p = stripLeading(p.slice(prefix.length));
  return isSafePackagePath(p) ? p : null;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function idList(value: unknown, legacyKey: "id" | "name"): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === "string") out.push(item);
    else if (isRecord(item) && typeof item[legacyKey] === "string") out.push(item[legacyKey] as string);
    else if (isRecord(item) && typeof item.id === "string") out.push(item.id);
  }
  return out;
}

/** Parse the JSON of a Foundry `module.json` (any Foundry generation: v9 legacy keys accepted). */
export function parseFoundryModuleManifest(raw: unknown): Result<FoundryModuleManifest> {
  if (!isRecord(raw)) return err("module.json is not an object");
  const id = typeof raw.id === "string" ? raw.id : typeof raw.name === "string" ? raw.name : "";
  if (!FOUNDRY_ID_RE.test(id)) return err("module.json needs an id (letters, digits, - and _, at most 64 chars)");
  const title = typeof raw.title === "string" && raw.title.trim() ? raw.title.trim().slice(0, 80) : id;
  const version = typeof raw.version === "string" ? raw.version : typeof raw.version === "number" ? String(raw.version) : "0.0.0";
  const description = typeof raw.description === "string" ? raw.description : "";
  const dropped: string[] = [];
  const paths = (list: unknown, what: string): string[] => {
    const out: string[] = [];
    for (const entry of stringList(list)) {
      const normalized = normalizeFoundryPath(entry, id);
      if (normalized === null) dropped.push(`${what} ${entry}`);
      else if (!out.includes(normalized)) out.push(normalized);
    }
    return out;
  };
  const languages: FoundryLanguage[] = [];
  if (Array.isArray(raw.languages)) {
    for (const entry of raw.languages) {
      if (!isRecord(entry) || typeof entry.lang !== "string" || typeof entry.path !== "string") continue;
      const path = normalizeFoundryPath(entry.path, id);
      if (path === null) { dropped.push(`language ${entry.path}`); continue; }
      languages.push({ lang: entry.lang, name: typeof entry.name === "string" ? entry.name : entry.lang, path });
    }
  }
  const packs: FoundryPack[] = [];
  if (Array.isArray(raw.packs)) {
    for (const entry of raw.packs) {
      if (!isRecord(entry) || typeof entry.name !== "string") continue;
      packs.push({
        name: entry.name,
        label: typeof entry.label === "string" ? entry.label : entry.name,
        path: typeof entry.path === "string" ? entry.path : `packs/${entry.name}`,
        type: typeof entry.type === "string" ? entry.type : typeof entry.entity === "string" ? entry.entity : "unknown",
      });
    }
  }
  const relationships = isRecord(raw.relationships) ? raw.relationships : {};
  const systems = [...new Set([...idList(relationships.systems, "id"), ...stringList(raw.systems)])];
  const requires = [...new Set([...idList(relationships.requires, "id"), ...idList(raw.dependencies, "name")])];
  const compat = isRecord(raw.compatibility) ? raw.compatibility : {};
  const compatText = (value: unknown): string | null =>
    typeof value === "string" ? value : typeof value === "number" ? String(value) : null;
  return okVal({
    id, title, version, description,
    esmodules: paths(raw.esmodules, "esmodule"),
    scripts: paths(raw.scripts, "script"),
    styles: paths(raw.styles, "style"),
    languages, packs, systems, requires,
    compatibility: {
      minimum: compatText(compat.minimum) ?? compatText(raw.minimumCoreVersion),
      verified: compatText(compat.verified) ?? compatText(raw.compatibleCoreVersion),
      maximum: compatText(compat.maximum),
    },
    socket: raw.socket === true,
    library: raw.library === true,
    dropped,
  });
}

/** The ArenaStar manifest (raw JSON shape) the kernel sees for an imported Foundry module. */
export function synthesizeFoundryPackageManifest(foundry: FoundryModuleManifest, resources: readonly string[]): Record<string, unknown> {
  const systems = foundry.systems.length ? ` Declares Foundry system(s): ${foundry.systems.join(", ")}.` : "";
  const description =
    `Foundry VTT module "${foundry.title}" ${foundry.version} (id ${foundry.id}), imported unmodified; ` +
    `runs through the ${FOUNDRY_ADAPTER.id} "${FOUNDRY_ADAPTER.profile}" profile.${systems}` +
    (foundry.description ? ` ${foundry.description.replace(/<[^>]*>/g, "").trim()}` : "");
  return {
    id: aisPackageIdForFoundry(foundry.id),
    name: foundry.title,
    version: aisVersionForFoundry(foundry.version),
    type: "module",
    description: description.slice(0, 2000),
    interconnect: {
      api: AIS_API_VERSION,
      entry: FOUNDRY_ENTRY_STUB_PATH,
      requires: [{ id: FOUNDRY_ADAPTER.id, version: FOUNDRY_ADAPTER.version }],
      runtime: {
        provider: FOUNDRY_ADAPTER.id,
        profile: FOUNDRY_ADAPTER.profile,
        scripts: [FOUNDRY_LOADER_STUB_PATH],
        configuration: FOUNDRY_MANIFEST_PATH,
        resources: [...resources],
      },
      // `foundry.info`: loader diagnostics; `foundry.api`: call the module's own globals/API from a reviewed script macro.
      commands: [{ id: "foundry.info", contract: 1 }, { id: "foundry.api", contract: 1 }],
      capabilities: [
        "runtime.execute", "package.resources.read", "module.settings.write", "ui.notify",
        "scene.tags.read", "scene.tags.write", "fx.play",
      ],
      sharing: "host-only",
    },
  };
}

export interface SynthesizedFoundryPackage {
  manifest: PackageManifest;
  /** The distribution's text files plus `manifest.json` and the two inert stubs. */
  files: Record<string, string>;
  foundry: FoundryModuleManifest;
}

/**
 * Turn the text files of a Foundry module distribution (already rooted: `module.json` at the
 * top) into a loadable ArenaStar package. `binaryPaths` are the entries the zip reader could
 * not decode; they are not an error (icons, fonts, LevelDB packs) but entry files among them are.
 */
export function synthesizeFoundryModulePackage(
  files: Record<string, string>, binaryPaths: readonly string[] = [],
): Result<SynthesizedFoundryPackage> {
  const text = files[FOUNDRY_MANIFEST_PATH];
  if (text === undefined) return err("package: module.json not found at the package root");
  let raw: unknown;
  try { raw = JSON.parse(text); } catch (error) {
    return err(`package: module.json is not valid JSON — ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = parseFoundryModuleManifest(raw);
  if (!parsed.ok) return err(`package: ${parsed.error}`);
  const foundry = parsed.value;
  if (!foundry.esmodules.length && !foundry.scripts.length)
    return err(`package ${foundry.id}: module.json lists no esmodules or scripts — nothing to run`);
  for (const entry of [...foundry.esmodules, ...foundry.scripts]) {
    if (files[entry] !== undefined) continue;
    return err(binaryPaths.includes(entry)
      ? `package ${foundry.id}: ${entry} is not UTF-8 text`
      : `package ${foundry.id}: ${entry} is listed in module.json but missing from the archive`);
  }
  const reserved = new Set([FOUNDRY_SYNTHESIZED_MANIFEST, FOUNDRY_ENTRY_STUB_PATH, FOUNDRY_LOADER_STUB_PATH]);
  const resources = Object.keys(files).filter((path) => !reserved.has(path) && isSafePackagePath(path)).sort();
  if (resources.length > FOUNDRY_MAX_TEXT_FILES)
    return err(`package ${foundry.id}: ${resources.length} text files; ArenaStar serves at most ${FOUNDRY_MAX_TEXT_FILES} per module`);
  const manifestRaw = synthesizeFoundryPackageManifest(foundry, resources);
  const manifest = validatePackageManifest(manifestRaw);
  if (!manifest.ok) return manifest;
  const header = `// Foundry VTT module ${foundry.id} ${foundry.version}: imported unmodified (D-482).\n`;
  const out: Record<string, string> = {};
  for (const path of resources) out[path] = files[path] as string;
  out[FOUNDRY_SYNTHESIZED_MANIFEST] = `${JSON.stringify(manifestRaw, null, 2)}\n`;
  out[FOUNDRY_ENTRY_STUB_PATH] = `${header}// Entry stub: the ${FOUNDRY_ADAPTER.id} adapter loads module.json's esmodules/scripts itself.\n`;
  out[FOUNDRY_LOADER_STUB_PATH] = `${header}// Runtime stub: see runtimeContext.distribution for the rewritten ESM graph.\n`;
  return okVal({ manifest: manifest.value, files: out, foundry });
}

/** `module.json` at the zip root or inside exactly one top-level folder (the shape packages use). */
export function resolveFoundryManifestPath(paths: readonly string[]): string | null {
  if (paths.includes(FOUNDRY_MANIFEST_PATH)) return FOUNDRY_MANIFEST_PATH;
  const roots = new Set(paths.filter((p) => p.endsWith(`/${FOUNDRY_MANIFEST_PATH}`)).map((p) => p.split("/")[0] ?? ""));
  if (roots.size !== 1) return null;
  const root = [...roots][0] ?? "";
  return root === "" ? null : `${root}/${FOUNDRY_MANIFEST_PATH}`;
}
