/**
 * D-482: the ES-module graph of an imported Foundry module, prepared for the sandboxed iframe.
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
  foundryId: string;
  kind: "module" | "system";
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
  files: string[];
  unresolved: FoundryUnresolvedImport[];
}

const dirname = (path: string): string => (path.includes("/") ? path.slice(0, path.lastIndexOf("/") + 1) : "");

const BARE_SHIMS = {
  fuzzysort: "__ais_shims/fuzzysort.js",
} as const;
const EMPTY_SHIM = "__ais_shims/empty.js";

export interface TsconfigAlias {
  alias: string;
  aliasPrefix: string | null;
  aliasExact: string | null;
  targets: Array<{ prefix: string | null; exact: string | null }>;
  baseDir: string;
}

function stripJsonComments(text: string): string {
  let out = "";
  let i = 0;
  let inString = false;
  let stringChar = "";
  let escape = false;
  while (i < text.length) {
    const ch = text[i] ?? "";
    const next = text[i + 1] ?? "";
    if (escape) { out += ch; escape = false; i++; continue; }
    if (inString) {
      if (ch === "\\") { escape = true; out += ch; i++; continue; }
      if (ch === stringChar) { inString = false; stringChar = ""; }
      out += ch; i++; continue;
    }
    if (ch === '"' || ch === "'") { inString = true; stringChar = ch; out += ch; i++; continue; }
    if (ch === "/" && next === "/") { while (i < text.length && text[i] !== "\n") i++; continue; }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < text.length) { if (text[i] === "*" && text[i + 1] === "/") { i += 2; break; } i++; }
      continue;
    }
    out += ch; i++;
  }
  return out;
}
export function parseTsConfigPaths(resources: Record<string, string>): TsconfigAlias[] {
  const aliases: TsconfigAlias[] = [];
  for (const [path, text] of Object.entries(resources)) {
    if (!path.endsWith("tsconfig.json")) continue;
    let parsed: any;
    try { parsed = JSON.parse(stripJsonComments(text)); } catch { continue; }
    const paths = parsed?.compilerOptions?.paths;
    if (!paths || typeof paths !== "object") continue;
    const baseDir = dirname(path);
    for (const [alias, targetsRaw] of Object.entries(paths)) {
      if (!Array.isArray(targetsRaw)) continue;
      const targets: Array<{ prefix: string | null; exact: string | null }> = [];
      for (const t of targetsRaw) {
        if (typeof t !== "string") continue;
        if (t.includes("../foundry")) continue;
        if (t.endsWith("/*")) targets.push({ prefix: t.slice(0, -1), exact: null });
        else targets.push({ prefix: null, exact: t });
      }
      if (!targets.length) continue;
      if (alias.endsWith("/*")) aliases.push({ alias, aliasPrefix: alias.slice(0, -1), aliasExact: alias.slice(0, -2), targets, baseDir });
      else aliases.push({ alias, aliasPrefix: null, aliasExact: alias, targets, baseDir });
    }
  }
  aliases.sort((a, b) => (b.aliasPrefix?.length ?? b.aliasExact?.length ?? 0) - (a.aliasPrefix?.length ?? a.aliasExact?.length ?? 0));
  return aliases;
}

function resolveAliasTarget(target: { prefix: string | null; exact: string | null }, baseDir: string, remainder: string): string | null {
  if (target.prefix !== null) {
    let p = target.prefix;
    if (p.startsWith("./")) p = p.slice(2);
    else if (p === "./" || p === ".") p = "";
    return `${baseDir}${p}${remainder}`;
  }
  if (target.exact !== null) {
    let p = target.exact;
    if (p.startsWith("./")) p = p.slice(2);
    return `${baseDir}${p}`;
  }
  return null;
}

function normalizePath(p: string): string {
  return p.split("/").reduce((out: string[], seg) => {
    if (seg === "" || seg === ".") return out;
    if (seg === "..") { out.pop(); return out; }
    out.push(seg);
    return out;
  }, []).join("/");
}

export function resolveFoundrySpecifier(
  specifier: string,
  fromFile: string,
  foundryId: string,
  has: (path: string) => boolean,
  aliases: readonly TsconfigAlias[] = [],
): string | null {
  const spec = specifier.trim();
  if (spec === "" || spec.startsWith(FOUNDRY_URL_SCHEME)) return null;

  if (spec.startsWith("@")) {
    for (const alias of aliases) {
      if (alias.aliasPrefix && spec.startsWith(alias.aliasPrefix)) {
        const remainder = spec.slice(alias.aliasPrefix.length);
        for (const target of alias.targets) {
          const candidateRaw = resolveAliasTarget(target, alias.baseDir, remainder);
          if (!candidateRaw) continue;
          const candidate = normalizePath(candidateRaw);
          if (has(candidate)) return candidate;
          if (!/\.[a-z]+$/i.test(candidate)) {
            const withMjs = `${candidate}.mjs`;
            if (has(withMjs)) return withMjs;
            const withJs = `${candidate}.js`;
            if (has(withJs)) return withJs;
          }
        }
      } else if (alias.aliasExact && spec === alias.aliasExact) {
        for (const target of alias.targets) {
          const candidateRaw = resolveAliasTarget(target, alias.baseDir, "");
          if (!candidateRaw) continue;
          const candidate = normalizePath(candidateRaw);
          if (has(candidate)) return candidate;
        }
      }
    }
  }

  if (!spec.startsWith(".") && !spec.startsWith("/") && !spec.includes(":")) {
    const shimPath = Object.hasOwn(BARE_SHIMS, spec) ? BARE_SHIMS[spec as keyof typeof BARE_SHIMS] : undefined;
    if (shimPath && has(shimPath)) return shimPath;
  }

  if (spec.endsWith(".css") || spec.endsWith(".d.ts")) {
    if (has(EMPTY_SHIM)) return EMPTY_SHIM;
  }

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
    if (candidate !== null && candidate.startsWith("modules/")) return null;
  } else if (spec.startsWith("/")) {
    candidate = normalizeFoundryPath(spec, foundryId);
  } else {
    return null;
  }
  if (candidate === null || candidate === "") return null;
  if ((candidate.endsWith(".css") || candidate.endsWith(".d.ts")) && has(EMPTY_SHIM)) return EMPTY_SHIM;
  return has(candidate) ? candidate : null;
}

// Robust import specifier rewriting: handles `import x from "y"`, `export * from "y"`, `import "y"`, `import("y")`
export interface RewrittenFoundrySource { text: string; unresolved: string[] }

export function rewriteFoundryModuleSource(
  text: string,
  file: string,
  foundryId: string,
  packageId: string,
  has: (path: string) => boolean,
  aliases: readonly TsconfigAlias[] = [],
): RewrittenFoundrySource {
  const unresolved: string[] = [];
  const mapped = (specifier: string): string => {
    const resolved = resolveFoundrySpecifier(specifier, file, foundryId, has, aliases);
    if (resolved === null) {
      if (specifier.startsWith("./") || specifier.startsWith("../") || specifier.startsWith("/") || specifier.startsWith("@")) unresolved.push(specifier);
      return specifier;
    }
    return foundryModuleUrl(packageId, resolved);
  };

  // Scan source and only rewrite import/export specifiers that appear in code (outside comments/strings)
  let out = "";
  let i = 0;
  const len = text.length;
  let inSL = false;
  let inML = false;
  let inSQ = false;
  let inDQ = false;
  let inBT = false;
  let esc = false;
  const isIdent = (c: string) => /[A-Za-z0-9_$]/.test(c);

  while (i < len) {
    const ch = text[i] ?? "";
    const nxt = text[i + 1] ?? "";
    if (esc) {
      esc = false;
      out += ch;
      i++;
      continue;
    }
    if (inSL) {
      out += ch;
      if (ch === "\n") inSL = false;
      i++;
      continue;
    }
    if (inML) {
      out += ch;
      if (ch === "*" && nxt === "/") {
        out += nxt;
        i += 2;
        inML = false;
        continue;
      }
      i++;
      continue;
    }
    if (inSQ) {
      out += ch;
      if (ch === "\\") esc = true;
      else if (ch === "'") inSQ = false;
      i++;
      continue;
    }
    if (inDQ) {
      out += ch;
      if (ch === "\\") esc = true;
      else if (ch === '"') inDQ = false;
      i++;
      continue;
    }
    if (inBT) {
      out += ch;
      if (ch === "\\") esc = true;
      else if (ch === "`") inBT = false;
      // Note: we intentionally stay inside template even for ${} expressions to keep scanner simple.
      // PF1 source does not import inside template interpolations.
      i++;
      continue;
    }
    // Not inside any string/comment
    if (ch === "/" && nxt === "/") {
      inSL = true;
      out += ch + nxt;
      i += 2;
      continue;
    }
    if (ch === "/" && nxt === "*") {
      inML = true;
      out += ch + nxt;
      i += 2;
      continue;
    }
    if (ch === "'") {
      inSQ = true;
      out += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inDQ = true;
      out += ch;
      i++;
      continue;
    }
    if (ch === "`") {
      inBT = true;
      out += ch;
      i++;
      continue;
    }

    // Emulate the Vite flags only in executable code.
    if (text.startsWith("import.meta.env", i) && !isIdent(text[i - 1] ?? "") && !isIdent(text[i + 15] ?? "")) {
      out += "({ DEV: false, PROD: true })";
      i += "import.meta.env".length;
      continue;
    }

    // Word boundary check for import/export: previous char should not be identifier
    const prev = i > 0 ? text[i - 1] ?? "" : "";
    if ((ch === "i" || ch === "e") && !isIdent(prev)) {
      const rest = text.slice(i);
      let m = rest.match(/^(?:import|export)\b[^"'`]*?\bfrom\s*(["'])([^"'`\n]+)\1/);
      if (m) {
        const quote = m[1] ?? '"';
        const spec = m[2] ?? "";
        const full = m[0] ?? "";
        const newSpec = mapped(spec);
        const rewritten = full.slice(0, full.indexOf(quote) + 1) + newSpec + full.slice(full.lastIndexOf(quote));
        out += rewritten;
        i += full.length;
        continue;
      }
      m = rest.match(/^import\s*(["'])([^"'`\n]+)\1/);
      if (m) {
        const quote = m[1] ?? '"';
        const spec = m[2] ?? "";
        const full = m[0] ?? "";
        const newSpec = mapped(spec);
        out += `import ${quote}${newSpec}${quote}`;
        i += full.length;
        continue;
      }
      m = rest.match(/^import\s*\(\s*(["'])([^"'`\n]+)\1\s*\)/);
      if (m) {
        const quote = m[1] ?? '"';
        const spec = m[2] ?? "";
        const newSpec = mapped(spec);
        out += `import(${quote}${newSpec}${quote})`;
        i += m[0].length;
        continue;
      }
    }

    out += ch;
    i++;
  }

  return { text: out, unresolved: [...new Set(unresolved)] };
}

const isModuleFile = (path: string): boolean => /\.(m?js)$/i.test(path);

const FUZZYSORT_SHIM = `// AIS shim for bare "fuzzysort" import (pf1 system source expects bundler to provide it)
export function single(search, target) {
  if (!search || !target) return null;
  const s = String(search).toLowerCase();
  const t = String(target?.target ?? target).toLowerCase();
  const idx = t.indexOf(s);
  if (idx === -1) return null;
  return { target, score: 1 - idx / Math.max(t.length, 1), indexes: Array.from({length: s.length}, (_,i)=>idx+i) };
}
export function go(search, targets, options) {
  if (!search) return [];
  const s = String(search).toLowerCase();
  const key = options?.key;
  const out = [];
  for (const obj of targets) {
    const raw = key ? obj?.[key] : obj;
    if (!raw) continue;
    const t = String(raw?.target ?? raw).toLowerCase();
    if (t.includes(s)) out.push({ obj, target: raw, score: 1 });
    if (out.length >= (options?.limit ?? 100)) break;
  }
  return out;
}
export function prepare(target) { return { target, _prepared: true }; }
export function highlight(result, open='<b>', close='</b>') { return result?.target ?? ''; }
export function score(result) { return result?.score ?? 0; }
export default { single, go, prepare, highlight, score };
`;

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
  const mutableResources: Record<string, string> = { ...resources };
  const allText = Object.values(resources).join("\n");
  if (allText.includes('from "fuzzysort"') || allText.includes("from 'fuzzysort'") || allText.includes('"fuzzysort"') || allText.includes("'fuzzysort'")) {
    if (!Object.hasOwn(mutableResources, BARE_SHIMS.fuzzysort)) {
      mutableResources[BARE_SHIMS.fuzzysort] = FUZZYSORT_SHIM;
    }
  }
  if (!Object.hasOwn(mutableResources, EMPTY_SHIM)) {
    mutableResources[EMPTY_SHIM] = "// AIS empty shim for CSS imports\n";
  }
  const has = (path: string): boolean => Object.hasOwn(mutableResources, path);
  const aliases = parseTsConfigPaths(mutableResources);
  const rewritten: Record<string, string> = Object.create(null) as Record<string, string>;
  const unresolved: FoundryUnresolvedImport[] = [];
  for (const [path, text] of Object.entries(mutableResources)) {
    if (!isModuleFile(path)) { rewritten[path] = text; continue; }
    const result = rewriteFoundryModuleSource(text, path, foundry.id, manifest.id, has, aliases);
    rewritten[path] = result.text;
    for (const specifier of result.unresolved) unresolved.push({ file: path, specifier });
  }
  const distribution: FoundryDistribution = {
    foundryId: foundry.id,
    kind: binding.configuration === "system.json" || binding.configuration.endsWith("/system.json") ? "system" : "module",
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
