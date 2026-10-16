/**
 * D-482: the ES-module graph of an imported Foundry module, prepared for the sandboxed iframe.
 *
 * The AIS iframe is an opaque-origin `srcdoc` document: module code can only run from blob
 * URLs minted inside the frame, and `blob:` URLs are not valid base URLs for relative
 * specifiers. The adapter therefore loads every module file as its own blob and tells the
 * browser how `import "./hotkeys.js"` maps onto those blobs with a single `<script
 * type="importmap">`. Import maps key on *absolute* specifiers, so this pass rewrites each
 * relative/package-absolute specifier to the canonical pseudo-URL
 *
 *     ais-foundry://<package id>/<package-relative path>
 *
 * Nothing else in the source is touched: no transpiling, no bundling, no identifier changes —
 * the module's own code runs as shipped. Bare specifiers (`import "lodash"`), other packages'
 * trees (`/systems/pf1/...`, `/modules/other/...`) and remote URLs cannot be served from the
 * archive and are left verbatim and reported; the browser then fails them exactly as Foundry
 * would when the dependency is absent.
 *
 * Pure text processing; the result is still inert data until the adapter imports it.
 */
import type { PackageManifest } from "../core/packageManifest";
import type { FoundryModuleManifest } from "../core/foundryModuleManifest";
import { normalizeFoundryPath, parseFoundryModuleManifest } from "../core/foundryModuleManifest";

export const FOUNDRY_URL_SCHEME = "ais-foundry://";

export function foundryModuleUrl(packageId: string, path: string): string {
  return `${FOUNDRY_URL_SCHEME}${packageId}/${path}`;
}

export interface FoundryUnresolvedImport { file: string; specifier: string }

export interface FoundryDistribution {
  /** The Foundry module id (verbatim) and the ArenaStar package id it was imported as. */
  foundryId: string;
  packageId: string;
  title: string;
  version: string;
  esmodules: string[];
  scripts: string[];
  styles: string[];
  languages: Array<{ lang: string; name: string; path: string }>;
  packs: Array<{ name: string; label: string; type: string; path: string }>;
  systems: string[];
  requires: string[];
  socket: boolean;
  /** Every text file served as a resource (the import map covers all `.js`/`.mjs` among them). */
  files: string[];
  /** Specifiers that could not be mapped onto the archive (left as written). */
  unresolved: FoundryUnresolvedImport[];
}

const dirname = (path: string): string => (path.includes("/") ? path.slice(0, path.lastIndexOf("/") + 1) : "");

/** Resolve one specifier against the file it appears in; null when it is not ours to serve. */
export function resolveFoundrySpecifier(specifier: string, fromFile: string, foundryId: string, has: (path: string) => boolean): string | null {
  const spec = specifier.trim();
  if (spec === "" || spec.startsWith(FOUNDRY_URL_SCHEME)) return null;
  let candidate: string | null;
  if (spec.startsWith("./") || spec.startsWith("../")) {
    const segments = `${dirname(fromFile)}${spec}`.split("/");
    const out: string[] = [];
    for (const segment of segments) {
      if (segment === "" || segment === ".") continue;
      if (segment === "..") { if (out.length === 0) return null; out.pop(); continue; }
      out.push(segment);
    }
    candidate = out.join("/");
  } else if (/^\/?modules\//.test(spec)) {
    candidate = normalizeFoundryPath(spec, foundryId);
    if (candidate !== null && candidate.startsWith("modules/")) return null; // another module's tree
  } else if (spec.startsWith("/")) {
    candidate = normalizeFoundryPath(spec, foundryId); // `/scripts/x.js` — Foundry serves it from the module root
  } else {
    return null; // bare specifier or URL
  }
  if (candidate === null || candidate === "") return null;
  return has(candidate) ? candidate : null;
}

// `import x from "./a.js"`, `import { a as b } from "./a.js"`, `export * from "./a.js"`,
// `import "./a.js"`, `import("./a.js")`. Deliberately conservative: unmatched spellings are left alone.
const STATIC_FROM_RE = /\b(import|export)(\s*(?:[\w$*{},\s]|\bas\b)*?\s*from\s*)(["'])([^"'\n]+)\3/g;
const SIDE_EFFECT_RE = /\bimport\s*(["'])([^"'\n]+)\1/g;
const DYNAMIC_RE = /\bimport\s*\(\s*(["'])([^"'\n]+)\1\s*\)/g;

export interface RewrittenFoundrySource { text: string; unresolved: string[] }

/** Rewrite the specifiers of one module file (see the file header). */
export function rewriteFoundryModuleSource(text: string, file: string, foundryId: string, packageId: string, has: (path: string) => boolean): RewrittenFoundrySource {
  const unresolved: string[] = [];
  const mapped = (specifier: string): string => {
    const resolved = resolveFoundrySpecifier(specifier, file, foundryId, has);
    if (resolved === null) {
      if (specifier.startsWith("./") || specifier.startsWith("../") || specifier.startsWith("/")) unresolved.push(specifier);
      return specifier;
    }
    return foundryModuleUrl(packageId, resolved);
  };
  const out = text
    .replace(STATIC_FROM_RE, (_m, keyword: string, clause: string, quote: string, specifier: string) =>
      `${keyword}${clause}${quote}${mapped(specifier)}${quote}`)
    .replace(SIDE_EFFECT_RE, (_m, quote: string, specifier: string) => `import ${quote}${mapped(specifier)}${quote}`)
    .replace(DYNAMIC_RE, (_m, quote: string, specifier: string) => `import(${quote}${mapped(specifier)}${quote})`);
  return { text: out, unresolved: [...new Set(unresolved)] };
}

const isModuleFile = (path: string): boolean => /\.(m?js)$/i.test(path);

/**
 * Prepare an imported Foundry package: returns the distribution description for
 * `runtimeContext.distribution` and the resource map with rewritten `.js` files, or null when
 * the package is not a Foundry import (no `foundry-module` runtime profile).
 */
export function prepareFoundryDistribution(
  manifest: PackageManifest, files: Record<string, string>, resources: Record<string, string>,
): { distribution: FoundryDistribution; resources: Record<string, string> } | null {
  const binding = manifest.interconnect?.runtime;
  if (!binding || binding.profile !== "foundry-module") return null;
  let raw: unknown;
  try { raw = JSON.parse(files[binding.configuration] ?? ""); } catch { return null; }
  const parsed = parseFoundryModuleManifest(raw);
  if (!parsed.ok) return null;
  const foundry: FoundryModuleManifest = parsed.value;
  const has = (path: string): boolean => Object.hasOwn(resources, path);
  const rewritten: Record<string, string> = Object.create(null) as Record<string, string>;
  const unresolved: FoundryUnresolvedImport[] = [];
  for (const [path, text] of Object.entries(resources)) {
    if (!isModuleFile(path)) { rewritten[path] = text; continue; }
    const result = rewriteFoundryModuleSource(text, path, foundry.id, manifest.id, has);
    rewritten[path] = result.text;
    for (const specifier of result.unresolved) unresolved.push({ file: path, specifier });
  }
  const distribution: FoundryDistribution = {
    foundryId: foundry.id,
    packageId: manifest.id,
    title: foundry.title,
    version: foundry.version,
    esmodules: foundry.esmodules.filter(has),
    scripts: foundry.scripts.filter(has),
    styles: foundry.styles.filter(has),
    languages: foundry.languages.filter((language) => has(language.path)),
    packs: foundry.packs.map((pack) => ({ name: pack.name, label: pack.label, type: pack.type, path: pack.path })),
    systems: foundry.systems,
    requires: foundry.requires,
    socket: foundry.socket,
    files: Object.keys(rewritten).sort(),
    unresolved: unresolved.slice(0, 64),
  };
  return { distribution, resources: rewritten };
}
