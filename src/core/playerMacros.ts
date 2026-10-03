/**
 * D-394: explicitly permitted player authoring in the GM's durable world.
 * Saving is NOT execution, publication, approval or global hotbar assignment.
 * The host builds the document; the request contains no ownership/grants/history.
 */
import type { MacroDocument, UserDocument } from "./documents";
import type { PermissionUser } from "./ownership";
import { can } from "./permissions";
import { validateScriptMacro, type ScriptInput, type ScriptPolicy } from "./scriptMacros";

export const PLAYER_MACRO_LIMITS = { name: 64, chat: 4096, script: 16_384, bytes: 32_768, perUser: 64 } as const;
export const UNAPPROVED_SCRIPT_HASH = "0".repeat(64);
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const control = (text: string, multiline = false): boolean => [...text].some((char) => {
  const code = char.charCodeAt(0);
  return code === 127 || code < 32 && !(multiline && [9, 10, 13].includes(code));
});

export type PlayerMacroDraft =
  | { kind: "chat"; name: string; command: string }
  | { kind: "script"; name: string; command: string; sceneId: string; inputs: ScriptInput[] };

/** Original PLAYER-submitted content, not the GM's later executable source/policy. */
export interface PlayerMacroAuthoring {
  version: 1;
  userId: string;
  draft: PlayerMacroDraft;
}

/** Read the actual user's replicated permission, never a draft-supplied flag or role. */
export function canSaveWorldMacros(user: PermissionUser | null, users: readonly UserDocument[]): boolean {
  if (!user) return false;
  if (user.role === "GM" || user.role === "ASSISTANT") return true;
  return users.some((entry) => entry._id === user.id && entry.type === "user" && entry.canSaveMacros === true);
}

/** Strict payload whitelist and real UTF-8 bound; normalize the name, preserve source exactly. */
export function validatePlayerMacroDraft(value: unknown):
  { ok: true; draft: PlayerMacroDraft } | { ok: false; error: string } {
  const bad = (error: string) => ({ ok: false as const, error });
  if (!record(value) || !["chat", "script"].includes(String(value.kind))) return bad("choose chat or a script draft");
  const fields = value.kind === "chat" ? ["kind", "name", "command"] : ["kind", "name", "command", "sceneId", "inputs"];
  if (Object.keys(value).some((key) => !fields.includes(key))) return bad("unexpected macro draft field");
  if (typeof value.name !== "string" || !value.name.trim() || value.name.trim().length > PLAYER_MACRO_LIMITS.name || control(value.name))
    return bad("macro name must be 1–64 characters without controls");
  if (typeof value.command !== "string" || !value.command.trim() || control(value.command, true) ||
      value.command.length > (value.kind === "chat" ? PLAYER_MACRO_LIMITS.chat : PLAYER_MACRO_LIMITS.script))
    return bad(value.kind === "chat" ? "chat command must be 1–4096 characters" : "script draft must be 1–16384 characters");
  try {
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > PLAYER_MACRO_LIMITS.bytes)
      return bad("macro draft exceeds 32 KiB");
  } catch { return bad("invalid macro draft"); }
  if (value.kind === "chat") return { ok: true, draft: { kind: "chat", name: value.name.trim(), command: value.command } };
  if (typeof value.sceneId !== "string" || !ID.test(value.sceneId) || !Array.isArray(value.inputs))
    return bad("script draft needs a scene and declared inputs");
  const policy = unapprovedPolicy(value.sceneId, value.inputs as ScriptInput[]);
  const checked = validateScriptMacro({ _id: "draft", type: "macro", kind: "script", name: value.name.trim(),
    command: value.command, ownership: { default: 0 }, flags: {}, system: {}, script: policy });
  if (!checked.ok) return bad(checked.error);
  return { ok: true, draft: { kind: "script", name: value.name.trim(), command: value.command,
    sceneId: value.sceneId, inputs: checked.policy.inputs.map(({ name, type, required }) =>
      ({ name, type, ...(required !== undefined ? { required } : {}) })) } };
}

function unapprovedPolicy(sceneId: string, inputs: ScriptInput[]): ScriptPolicy {
  return { version: 1, approvedHash: UNAPPROVED_SCRIPT_HASH, sceneId, runAs: "caller", playerCallable: false,
    grants: [], inputs };
}

/** Malformed imported author metadata is not an ownership/management credential. */
export function playerMacroAuthoring(macro: MacroDocument): PlayerMacroAuthoring | null {
  const value: unknown = macro.playerAuthoring;
  if (!record(value) || Object.keys(value).some((key) => !["version", "userId", "draft"].includes(key)) ||
      value.version !== 1 || typeof value.userId !== "string" || !ID.test(value.userId)) return null;
  const checked = validatePlayerMacroDraft(value.draft);
  return checked.ok ? { version: 1, userId: value.userId, draft: checked.draft } : null;
}

/** Permission revocation and a GM's per-document ownership revocation both take effect live. */
export function ownsPlayerMacro(user: PermissionUser, macro: MacroDocument): boolean {
  return macro.type === "macro" && ["chat", "script"].includes(macro.kind) &&
    playerMacroAuthoring(macro)?.userId === user.id && can(user, "update", macro, "macros");
}

/** Owner-only source DTO. No GM-edited command/policy/grant can enter it by projection. */
export function projectPlayerMacroAuthoring(macro: MacroDocument, user: PermissionUser): PlayerMacroAuthoring | null {
  const authoring = playerMacroAuthoring(macro);
  return authoring?.userId === user.id && macro.type === "macro" && ["chat", "script"].includes(macro.kind) &&
    can(user, "update", macro, "macros") ? authoring : null;
}

/** Canonical host-side world document; approval is revoked on EVERY player revision. */
export function buildPlayerMacro(
  id: string, userId: string, draft: PlayerMacroDraft, previous?: MacroDocument,
): MacroDocument {
  const core = previous?.flags.core;
  const slot = record(core) && typeof core.slot === "number" && Number.isInteger(core.slot) && core.slot >= 1 && core.slot <= 5
    ? core.slot : null;
  return { _id: id, type: "macro", kind: draft.kind, name: draft.name, command: draft.command,
    ownership: { default: 0, [userId]: 3 }, flags: { core: {
      ...(draft.kind === "script" ? { playerCallable: false } : {}), ...(slot ? { slot } : {}),
    } }, system: {}, playerAuthoring: { version: 1, userId, draft: structuredClone(draft) },
    ...(draft.kind === "script" ? { script: unapprovedPolicy(draft.sceneId, structuredClone(draft.inputs)) } : {}),
    // Invocation replay history is never caller-writable and never cleared by a kind switch.
    ...(previous?.scriptState ? { scriptState: structuredClone(previous.scriptState) } : {}),
  };
}
