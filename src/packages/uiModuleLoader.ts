/**
 * D-475: load a system package's `ui.js` in the page — the components it contributes to the
 * shells' windows — through the same blob-URL import the rules module uses, then gate the shape:
 * `{ api: "arena.ui/1", components: { <slot>: function } }`. The shell mounts a component only
 * through a known slot (`PackageUiSlot`), so an unknown key is ignored, not an error.
 *
 * Not sandboxed: like `rules.js` (D-471/D-472) a UI module runs with the page's authority, which
 * is why it travels under the same consent/first-party trust as the rules artifact.
 */
import type { Component } from "svelte";
import { err, okVal, type Result } from "../core/result";

export const PACKAGE_UI_API = "arena.ui/1";

/** The slots a shell knows how to mount. Adding one is a shell change; filling one is the package's. */
export type PackageUiSlot = "battleAnalysis";

export type PackageUiComponent = Component<Record<string, unknown>>;

export interface PackageUiModule {
  api: typeof PACKAGE_UI_API;
  components: Readonly<Partial<Record<PackageUiSlot, PackageUiComponent>>>;
}

const KNOWN_SLOTS: readonly PackageUiSlot[] = ["battleAnalysis"];

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/** Shape gate over whatever the module evaluated to (namespace or default export). */
export function validateUiModule(candidate: unknown): Result<PackageUiModule> {
  const ns = isRecord(candidate) && "default" in candidate ? candidate.default : candidate;
  if (!isRecord(ns)) return err("ui package: the module has no default export object");
  if (ns.api !== PACKAGE_UI_API) return err(`ui package: api must be ${PACKAGE_UI_API}`);
  if (!isRecord(ns.components)) return err("ui package: components must be an object");
  const components: Partial<Record<PackageUiSlot, PackageUiComponent>> = {};
  for (const slot of KNOWN_SLOTS) {
    const value = ns.components[slot];
    if (value === undefined) continue;
    if (typeof value !== "function") return err(`ui package: components.${slot} must be a component function`);
    components[slot] = value as PackageUiComponent;
  }
  return okVal({ api: PACKAGE_UI_API, components: Object.freeze(components) });
}

async function tryImport(url: string): Promise<Result<unknown>> {
  try {
    return okVal(await import(/* @vite-ignore */ url));
  } catch (e) {
    return err(`ui package: import failed — ${e instanceof Error ? e.message : String(e)}`);
  }
}

function sourceToDataUrl(source: string): string {
  const bytes = new TextEncoder().encode(source);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return "data:text/javascript;base64," + btoa(bin);
}

/** Import + validate a `ui.js` source in the page. Errors come back as Err, never thrown. */
export async function importUiModule(source: string): Promise<Result<PackageUiModule>> {
  const hasBlob = typeof Blob === "function" && typeof URL !== "undefined" && typeof URL.createObjectURL === "function";
  const blobUrl = hasBlob ? URL.createObjectURL(new Blob([source], { type: "text/javascript" })) : null;
  try {
    let ns = blobUrl !== null ? await tryImport(blobUrl) : null;
    if (!ns?.ok) ns = await tryImport(sourceToDataUrl(source));
    if (!ns.ok) return ns;
    return validateUiModule(ns.value);
  } finally {
    if (blobUrl !== null) URL.revokeObjectURL(blobUrl);
  }
}
