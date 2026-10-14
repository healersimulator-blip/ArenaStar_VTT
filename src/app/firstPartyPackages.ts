/**
 * D-473: the packages ArenaStar ships inside its own build — today `pf1e-mass-battles` (the
 * strategic PF1e ruleset, `type: "system"`) and `pf1e-core` (its content companion,
 * `type: "data"`). `pnpm build:systems` builds them exactly as a GM would import them and
 * `vite.config.ts` inlines the zips (base64) plus the sha256 of each `rules.js` into the shell.
 *
 * Two things hang off that list:
 *   - a fresh world can be created *on* the first-party ruleset with no file on disk — the
 *     New-world wizard's default and the `?e2e=1&rules=pf1e` host route (D-473 owner decision:
 *     the default world is a PF1e world, so the PF1e code that leaves the main bundle still
 *     reaches every world that wants it);
 *   - a player shell recognises the rules artifact its GM announces (D-472 `sim.artifact.hash`)
 *     as first-party when the hash is in this list, and loads it without the consent prompt:
 *     it is the code this very release used to bundle, now carried by the world file instead.
 *
 * The list is empty in a tree built without `build:systems` (plain `vite dev`, bare vitest);
 * every caller must treat "no first-party package" as the ordinary built-in path.
 */
import type { PackageManifest } from "../core/packageManifest";
import { readZipPackage, type LoadedPackage } from "../packages/packageLoader";

export interface FirstPartyPackage {
  id: string;
  name: string;
  version: string;
  type: PackageManifest["type"];
  dependencies: readonly string[];
  /** sha256 (hex) of the system package's `rules.js` bytes — the D-472 artifact hash; null for data packages. */
  rulesSha256: string | null;
  /** The package zip, base64 — what `readZipPackage` reads. */
  zipBase64: string;
}

function embedded(): readonly FirstPartyPackage[] {
  const injected = typeof __FIRST_PARTY_PACKAGES__ === "undefined" ? undefined : __FIRST_PARTY_PACKAGES__;
  if (!Array.isArray(injected)) return [];
  return injected.filter((entry): entry is FirstPartyPackage =>
    typeof entry === "object" && entry !== null &&
    typeof entry.id === "string" && typeof entry.version === "string" && typeof entry.zipBase64 === "string" &&
    (entry.type === "system" || entry.type === "data" || entry.type === "module" || entry.type === "ui"));
}

/** Every first-party package in this build (empty without the build step). */
export function firstPartyPackages(list: readonly FirstPartyPackage[] = embedded()): readonly FirstPartyPackage[] {
  return list;
}

/** The first-party strategic ruleset, if this build carries one. */
export function firstPartySystemPackage(list: readonly FirstPartyPackage[] = embedded()): FirstPartyPackage | null {
  return list.find((entry) => entry.type === "system" && entry.rulesSha256 !== null) ?? null;
}

/** D-473: is this D-472 rules artifact one of this build's own packages? */
export function isFirstPartyArtifact(hash: string, list: readonly FirstPartyPackage[] = embedded()): boolean {
  return /^[0-9a-f]{64}$/.test(hash) && list.some((entry) => entry.rulesSha256 === hash);
}

/** Decode the embedded zip (no Buffer: the shell runs in the page). */
export function firstPartyPackageBytes(entry: FirstPartyPackage): Uint8Array {
  const binary = atob(entry.zipBase64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export interface FirstPartyRecipePackages {
  /** The strategic ruleset. */
  ruleset: LoadedPackage;
  /** The data packages the ruleset declares as companions, in declaration order (only first-party ones). */
  content: LoadedPackage[];
}

/**
 * The first-party ruleset and its declared first-party companions, read from the embedded zips
 * through the same loader a GM's file goes through. `null` when the build carries no ruleset;
 * throws when an embedded zip does not read — that is a broken build, not a user error.
 */
export async function loadFirstPartyRecipePackages(
  list: readonly FirstPartyPackage[] = embedded(),
): Promise<FirstPartyRecipePackages | null> {
  const system = firstPartySystemPackage(list);
  if (!system) return null;
  const read = async (entry: FirstPartyPackage): Promise<LoadedPackage> => {
    const loaded = await readZipPackage(firstPartyPackageBytes(entry));
    if (!loaded.ok) throw new Error(`first-party package ${entry.id}@${entry.version} does not read: ${loaded.error}`);
    return loaded.value;
  };
  const ruleset = await read(system);
  const content: LoadedPackage[] = [];
  for (const dependency of system.dependencies) {
    const companion = list.find((entry) => entry.id === dependency && entry.type === "data");
    if (companion) content.push(await read(companion));
  }
  return { ruleset, content };
}
