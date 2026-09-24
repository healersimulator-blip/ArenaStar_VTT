/**
 * Reviewed, version-pinned JavaScript macros. A saved macro is not executable
 * merely because its `kind` is "script": the GM must publish a policy and an
 * SHA-256 approval of BOTH the source and the policy. Player input is a small
 * typed record, never a command, action list, grant or unvalidated document ref.
 */
import type { Json, MacroDocument } from "./documents";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

export const SCRIPT_GRANTS = ["chat", "tags.read", "tags.write", "fx", "automation", "macros", "prefabs.place", "summons"] as const;
export type ScriptGrant = (typeof SCRIPT_GRANTS)[number];
export type ScriptInputType = "string" | "number" | "boolean" | "token";
export interface ScriptInput {
  name: string;
  type: ScriptInputType;
  required?: boolean;
}
export interface ScriptPolicy {
  version: 1;
  /** SHA-256 of the *entire* reviewed source + policy (excluding this field). */
  approvedHash: string;
  /** Immutable execution context for a given revision (not chosen by the caller). */
  sceneId: string;
  /** `gm` is an explicit GM-granted elevation; actions still enforce scene/target constraints. */
  runAs: "caller" | "gm";
  playerCallable: boolean;
  grants: ScriptGrant[];
  inputs: ScriptInput[];
  /** Exact GM-reviewed saved templates a player may place via elevated code. */
  prefabIds?: string[];
  /** Exact approved summon presets for elevated player-callable code. */
  summonIds?: string[];
}
export interface ScriptHistory {
  /** Durable at-most-once keys, recorded BEFORE starting a worker; bounded to 256. */
  recent: Array<{ key: string; at: number; revision: string }>;
}
export type ScriptArgs = Record<string, Json>;

const ID = /^[a-zA-Z0-9_-]{1,128}$/;
const NAME = /^[a-zA-Z][a-zA-Z0-9_]{0,31}$/;
const HASH = /^[0-9a-f]{64}$/;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const only = (v: Record<string, unknown>, fields: readonly string[]) => Object.keys(v).every((k) => fields.includes(k));

/** Validate at publish time AND again at execution (imported worlds can be malformed). */
export function validateScriptMacro(doc: MacroDocument): { ok: true; policy: ScriptPolicy } | { ok: false; error: string } {
  const bad = (error: string) => ({ ok: false as const, error });
  if (doc.kind !== "script" || typeof doc.command !== "string" ||
      !doc.command.trim() || doc.command.length > 32_768) return bad("script source must be 1–32768 characters");
  const p: unknown = doc.script;
  if (!object(p) || !only(p, ["version", "approvedHash", "sceneId", "runAs", "playerCallable", "grants", "inputs", "prefabIds", "summonIds"]) ||
      p.version !== 1 || typeof p.approvedHash !== "string" || !HASH.test(p.approvedHash) ||
      typeof p.sceneId !== "string" || !ID.test(p.sceneId) ||
      !["caller", "gm"].includes(String(p.runAs)) || typeof p.playerCallable !== "boolean" ||
      !Array.isArray(p.grants) || p.grants.length > SCRIPT_GRANTS.length ||
      p.grants.some((g: unknown) => !SCRIPT_GRANTS.includes(g as ScriptGrant)) ||
      new Set(p.grants).size !== p.grants.length ||
      !Array.isArray(p.inputs) || p.inputs.length > 16 ||
      (p.prefabIds !== undefined && (!Array.isArray(p.prefabIds) || p.prefabIds.length > 16 ||
        p.prefabIds.some((id: unknown) => typeof id !== "string" || !ID.test(id)) ||
        new Set(p.prefabIds).size !== p.prefabIds.length)) ||
      (p.summonIds !== undefined && (!Array.isArray(p.summonIds) || p.summonIds.length > 16 ||
        p.summonIds.some((id: unknown) => typeof id !== "string" || !ID.test(id)) ||
        new Set(p.summonIds).size !== p.summonIds.length))) return bad("invalid script policy");
  if (p.playerCallable && p.grants.includes("prefabs.place") &&
      (p.runAs !== "gm" || !(p.prefabIds as string[] | undefined)?.length))
    return bad("player-callable prefab scripts need GM elevation and explicit reviewed prefab IDs");
  if (p.playerCallable && p.grants.includes("summons") && p.runAs === "gm" &&
      !(p.summonIds as string[] | undefined)?.length)
    return bad("player-callable elevated summon scripts need approved preset IDs");
  const names = new Set<string>();
  for (const field of p.inputs) {
    if (!object(field) || !only(field, ["name", "type", "required"]) ||
        typeof field.name !== "string" || !NAME.test(field.name) || names.has(field.name) ||
        !["string", "number", "boolean", "token"].includes(String(field.type)) ||
        (field.required !== undefined && typeof field.required !== "boolean")) return bad("invalid script input schema");
    names.add(field.name);
  }
  if (doc.scriptState !== undefined) {
    const state: unknown = doc.scriptState;
    if (!object(state) || !only(state, ["recent"]) || !Array.isArray(state.recent) || state.recent.length > 256 ||
        state.recent.some((row: unknown) => !object(row) || !only(row, ["key", "at", "revision"]) ||
          typeof row.key !== "string" || row.key.length < 1 || row.key.length > 300 ||
          typeof row.at !== "number" || !Number.isFinite(row.at) || row.at < 0 ||
          typeof row.revision !== "string" || !HASH.test(row.revision))) return bad("invalid script execution history");
  }
  return { ok: true, policy: p as unknown as ScriptPolicy };
}

/** Canonical serialization used by both reviewed publication and synchronous host preflight. */
function approvalBody(source: string, policy: Omit<ScriptPolicy, "approvedHash">): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(JSON.stringify({ source, version: policy.version, sceneId: policy.sceneId,
    runAs: policy.runAs, playerCallable: policy.playerCallable, grants: policy.grants, inputs: policy.inputs,
    ...(policy.prefabIds !== undefined ? { prefabIds: policy.prefabIds } : {}),
    ...(policy.summonIds !== undefined ? { summonIds: policy.summonIds } : {}) }));
}

/** SHA-256 approval bound to source AND publication, grants, scene and argument schema. */
export async function scriptApprovalHash(source: string, policy: Omit<ScriptPolicy, "approvedHash">): Promise<string> {
  return bytesToHex(new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", approvalBody(source, policy))));
}

/** Same digest synchronously: tile-graph history/ops must NOT commit before hash preflight. */
export function scriptApprovalHashSync(source: string, policy: Omit<ScriptPolicy, "approvedHash">): string {
  return bytesToHex(sha256(approvalBody(source, policy)));
}

/** Returns ONLY declared named arguments. Token visibility is checked against live host state. */
export function validateScriptArgs(
  value: unknown, policy: ScriptPolicy, tokenVisible: (id: string) => boolean,
): { ok: true; args: ScriptArgs } | { ok: false; error: string } {
  const bad = (error: string) => ({ ok: false as const, error });
  if (!object(value) || Object.keys(value).length > 16) return bad("arguments must be a named record");
  let bytes: number;
  try { bytes = JSON.stringify(value).length; } catch { return bad("unserializable arguments"); }
  if (bytes > 8192) return bad("macro input exceeds 8 KiB");
  const declared = new Map(policy.inputs.map((field) => [field.name, field]));
  if (Object.keys(value).some((key) => !declared.has(key))) return bad("unknown macro argument");
  const args: ScriptArgs = {};
  for (const field of policy.inputs) {
    const v = value[field.name];
    if (v === undefined || v === null) {
      if (field.required) return bad(`missing ${field.name}`);
      continue;
    }
    if (field.type === "string" && (typeof v !== "string" || v.length > 256)) return bad(`invalid ${field.name}`);
    if (field.type === "number" && (typeof v !== "number" || !Number.isFinite(v) || Math.abs(v) > 1e9)) return bad(`invalid ${field.name}`);
    if (field.type === "boolean" && typeof v !== "boolean") return bad(`invalid ${field.name}`);
    if (field.type === "token" && (typeof v !== "string" || !ID.test(v) || !tokenVisible(v)))
      return bad(`invalid or invisible ${field.name}`);
    args[field.name] = v as Json;
  }
  return { ok: true, args };
}

/** Frame-boundary JSON (worker returns and RPC inputs); not a clone or a grant. */
export function boundedJson(value: unknown, max = 16_384): value is Json {
  const seen = new Set<object>();
  const valid = (v: unknown, depth: number): boolean => {
    if (v === null || typeof v === "string" || typeof v === "boolean") return true;
    if (typeof v === "number") return Number.isFinite(v);
    if (depth > 16 || typeof v !== "object" || seen.has(v)) return false;
    const prototype: unknown = Object.getPrototypeOf(v);
    if (!Array.isArray(v) && prototype !== Object.prototype && prototype !== null) return false;
    seen.add(v);
    const values = Array.isArray(v) ? v : Object.values(v);
    const ok = values.every((entry) => valid(entry, depth + 1));
    seen.delete(v);
    return ok;
  };
  try { return valid(value, 0) && JSON.stringify(value).length <= max; }
  catch { return false; }
}
