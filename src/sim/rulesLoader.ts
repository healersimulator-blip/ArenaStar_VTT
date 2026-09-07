/**
 * §12 RulesModule package loader — imports a rules package (one
 * self-contained ESM source text, no further imports) from a Blob URL and
 * shape-validates it against the RulesModule contract BEFORE any rules code
 * is handed to the runner. Runs inside the sandboxed SimWorker (after
 * hardenSandbox removed fetch/XHR/WS/importScripts/IDB — dynamic import of a
 * blob: module remains, which is exactly the sanctioned loading path).
 *
 * Node/vitest-safe: when URL.createObjectURL is unavailable the same source
 * is imported from a data: URL, so the loader and InlineSimRunner package
 * path are testable outside the browser.
 */
import type { RulesModule } from "../core/rules";
import type { ModelColumnType } from "../core/strategic";
import type { Result } from "../core/result";
import { err, okVal } from "../core/result";

/** §4A sys column element types (mirror of pool COLUMN_CTORS keys). */
const COLUMN_TYPES: readonly ModelColumnType[] = [
  "f32",
  "f64",
  "i32",
  "u32",
  "i16",
  "u16",
  "i8",
  "u8",
];

/** Schema echo reported back to the host (no live module crosses the wire). */
export interface RulesPackageInfo {
  version: string;
  subPhases: string[];
  orderTypes: string[];
  /**
   * Import mechanism: "blob" (worker sandbox, the §12 path), "data" (Node),
   * "eval" (engines whose classic workers cannot import module scripts, e.g.
   * WebKit — single-`export default`-expression packages only).
   */
  urlScheme: "blob" | "data" | "eval";
}

export interface LoadedRulesModule {
  module: RulesModule;
  info: RulesPackageInfo;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string");

/** Pick the rules object out of a module namespace (`default` or `rules`). */
function pickExport(ns: unknown): Result<Record<string, unknown>> {
  if (!isRecord(ns)) return err("rules package: module namespace is not an object");
  if (ns.default !== undefined) {
    return isRecord(ns.default)
      ? okVal(ns.default)
      : err("rules package: default export is not an object");
  }
  if (ns.rules !== undefined) {
    return isRecord(ns.rules)
      ? okVal(ns.rules)
      : err("rules package: `rules` export is not an object");
  }
  return err("rules package: no `default` or `rules` export");
}

/** Shape-validate a module namespace (or already-picked object) — §12 contract. */
export function validateRulesModule(candidate: unknown): Result<RulesModule> {
  const picked = pickExport(candidate);
  if (!picked.ok) return picked;
  const m = picked.value;
  if (!isRecord(m.schema)) return err("rules package: missing schema object");
  const { schema } = m;
  if (typeof schema.version !== "string" || schema.version.length === 0) {
    return err("rules package: schema.version must be a non-empty string");
  }
  if (!isRecord(schema.modelColumns)) {
    return err("rules package: schema.modelColumns must be an object");
  }
  for (const [name, type] of Object.entries(schema.modelColumns)) {
    if (!COLUMN_TYPES.includes(type as ModelColumnType)) {
      return err(`rules package: schema.modelColumns.${name} has unsupported type ${String(type)}`);
    }
  }
  if (!isRecord(schema.unitTypes)) {
    return err("rules package: schema.unitTypes must be an object");
  }
  if (!isStringArray(schema.orderTypes)) {
    return err("rules package: schema.orderTypes must be string[]");
  }
  if (!isStringArray(schema.subPhases)) {
    return err("rules package: schema.subPhases must be string[]");
  }
  for (const fn of ["validateOrder", "resolveTurn", "detection"] as const) {
    if (typeof m[fn] !== "function") {
      return err(`rules package: ${fn} is not a function`);
    }
  }
  for (const fn of ["tick", "forecast", "migrate"] as const) {
    if (m[fn] !== undefined && typeof m[fn] !== "function") {
      return err(`rules package: ${fn} must be a function when present`);
    }
  }
  return okVal(m as unknown as RulesModule);
}

/** Schema echo for a validated module. */
export function rulesInfo(
  module: RulesModule,
  urlScheme: "blob" | "data" | "eval",
): RulesPackageInfo {
  return {
    version: module.schema.version,
    subPhases: [...module.schema.subPhases],
    orderTypes: [...module.schema.orderTypes],
    urlScheme,
  };
}

/** Unicode-safe data: module URL (Node fallback — no createObjectURL there). */
function sourceToDataUrl(source: string): string {
  const bytes = new TextEncoder().encode(source);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return "data:text/javascript;base64," + btoa(bin);
}

async function tryImport(url: string): Promise<Result<unknown>> {
  try {
    return okVal(await import(/* @vite-ignore */ url));
  } catch (e) {
    return err(`rules package: import failed — ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Engine-proof last resort for classic workers that cannot import module
 * scripts (WebKit): the documented minimal package form is a single
 * `export default <object expression>;`. Evaluated inside the same hardened
 * sandbox — same trust level as import().
 */
export function evalRulesModule(source: string): Result<RulesModule> {
  const m = /^\s*export\s+default\s+([\s\S]+?);?\s*$/.exec(source);
  if (!m) {
    return err(
      "rules package: engine cannot import module scripts and source is not the `export default <expression>` form",
    );
  }
  try {
    const factory = new Function(`"use strict"; return (${m[1]});`);
    return validateRulesModule({ default: factory() });
  } catch (e) {
    return err(`rules package: eval failed — ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Import + validate a package source. Blob URL inside the worker sandbox
 * (the §12 loading path); falls back to a data: URL on engines whose module
 * loader rejects blob: URLs (Node), then to the eval form (WebKit classic
 * workers). Blob URLs are always revoked. Errors come back as Err, never
 * thrown.
 */
export async function importRulesModule(source: string): Promise<Result<LoadedRulesModule>> {
  const hasBlob =
    typeof Blob === "function" &&
    typeof URL !== "undefined" &&
    typeof URL.createObjectURL === "function";
  const blobUrl = hasBlob
    ? URL.createObjectURL(new Blob([source], { type: "text/javascript" }))
    : null;
  try {
    let urlScheme: "blob" | "data" | "eval" = "blob";
    let ns = blobUrl !== null ? await tryImport(blobUrl) : null;
    if (!ns?.ok) {
      urlScheme = "data";
      ns = await tryImport(sourceToDataUrl(source));
    }
    if (!ns.ok) {
      urlScheme = "eval";
      const ev = evalRulesModule(source);
      if (!ev.ok) return ev;
      return okVal({ module: ev.value, info: rulesInfo(ev.value, urlScheme) });
    }
    const mod = validateRulesModule(ns.value);
    if (!mod.ok) return mod;
    return okVal({ module: mod.value, info: rulesInfo(mod.value, urlScheme) });
  } finally {
    if (blobUrl !== null) URL.revokeObjectURL(blobUrl);
  }
}

/** Source-keyed module cache (worker keeps one import per package text). */
export class RulesModuleRegistry {
  private readonly bySource = new Map<string, LoadedRulesModule>();

  get(source: string): LoadedRulesModule | undefined {
    return this.bySource.get(source);
  }

  set(source: string, loaded: LoadedRulesModule): void {
    this.bySource.set(source, loaded);
  }

  get size(): number {
    return this.bySource.size;
  }
}
