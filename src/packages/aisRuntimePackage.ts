/** Inert assembly of reviewed runtime-provider + guest packages. No imported code runs here. */
import type { Json } from "../core/documents";
import type { PackageManifest } from "../core/packageManifest";
import { boundedJson } from "../core/scriptMacros";
import { packageContentHash } from "./packageHash";
import { prepareFoundryDistribution, type FoundryDistribution } from "./foundryEsmGraph";

export interface AisPackageSource {
  id: string;
  version: string;
  manifest: PackageManifest;
  files: Record<string, string>;
}

export function aisOwnSource(pkg: AisPackageSource): string {
  const spec = pkg.manifest.interconnect;
  if (!spec) throw new Error(`Not an AIS module: ${pkg.id}`);
  const paths = [...(spec.runtime?.scripts ?? spec.runtimeProvider?.scripts ?? []), spec.entry];
  let source = "";
  for (const path of paths) {
    const text = pkg.files[path];
    if (!text?.trim()) throw new Error(`AIS executable file ${pkg.id}/${path} is missing or empty`);
    const label = JSON.stringify(path).replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
    source += `\n// AIS package ${pkg.id}: ${label}\n${text}\n;\n`;
  }
  if (new TextEncoder().encode(source).length > 1024 * 1024)
    throw new Error("AIS executable source exceeds 1 MiB");
  return source;
}

export function aisRuntimeConfiguration(pkg: AisPackageSource): Json {
  const path = pkg.manifest.interconnect?.runtime?.configuration;
  if (!path) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(pkg.files[path] ?? ""); }
  catch { throw new Error(`Invalid AIS runtime configuration: ${path}`); }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object" || !boundedJson(parsed, 65_536))
    throw new Error("AIS runtime configuration must be a bounded JSON object no larger than 64 KiB");
  return parsed as Json;
}

export function aisRuntimePackage(pkg: AisPackageSource, packages: readonly AisPackageSource[]) {
  const binding = pkg.manifest.interconnect?.runtime;
  if (!binding) return null;
  const provider = packages.find((candidate) => candidate.id === binding.provider);
  if (!provider?.manifest.interconnect?.runtimeProvider?.profiles.includes(binding.profile))
    throw new Error(`Runtime ${binding.provider} does not provide ${binding.profile}`);
  const required = pkg.manifest.interconnect?.requires?.find((dep) => dep.id === provider.id);
  if (required?.version !== provider.version || required.optional)
    throw new Error(`Runtime ${provider.id} does not match the required exact version`);
  const configuration = aisRuntimeConfiguration(pkg);
  const hash = packageContentHash({
    contract: "arena.ais.runtime/1",
    guest: packageContentHash(pkg.files),
    provider: packageContentHash(provider.files),
    profile: binding.profile,
  });
  // D-482: a Foundry-format guest also carries its distribution description for the adapter.
  const distribution = aisFoundryDistribution(pkg);
  return { provider, configuration, hash,
    ...(distribution ? { distribution } : {}),
    source: aisOwnSource(provider) + aisOwnSource(pkg) };
}

function rawRuntimeResources(pkg: AisPackageSource): Record<string, string> {
  const resources: Record<string, string> = Object.create(null) as Record<string, string>;
  let total = 0;
  for (const path of pkg.manifest.interconnect?.runtime?.resources ?? []) {
    const text = pkg.files[path];
    if (text === undefined) throw new Error(`Missing runtime resource: ${path}`);
    const size = new TextEncoder().encode(text).length;
    if (size > 2 * 1024 * 1024 || (total += size) > 8 * 1024 * 1024) throw new Error("Runtime resource budget exceeded");
    resources[path] = text;
  }
  return resources;
}

/**
 * Data-only resource index; no ambient file access or arbitrary package paths. For a Foundry
 * import (D-482) the `.js` resources carry rewritten import specifiers (see foundryEsmGraph).
 */
export function aisRuntimeResources(pkg: AisPackageSource): Record<string, string> {
  const resources = rawRuntimeResources(pkg);
  return prepareFoundryDistribution(pkg.manifest, pkg.files, resources)?.resources ?? resources;
}

/** D-482: the distribution description of a Foundry import, null for every other package. */
export function aisFoundryDistribution(pkg: AisPackageSource): FoundryDistribution | null {
  return prepareFoundryDistribution(pkg.manifest, pkg.files, rawRuntimeResources(pkg))?.distribution ?? null;
}
