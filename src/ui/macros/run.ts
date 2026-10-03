/**
 * §10 chat-macro runner — shared by the macros window, the hotbar and the
 * 1-5 keybindings. Script macros are stored but not executed until the
 * system API lands (M3, D-079).
 */
import type { ClientSync } from "../../client/sync";
import type { MacroDocument, SceneDocument } from "../../core/documents";
import { buildChatMessage, parseChatCommand } from "../../core/chat";
import { bindMacroArgs, macroSelection, type MacroSelection } from "../../core/macroArgs";
import { macroAutomationInputs } from "../../core/macroAutomation";

/**
 * D-388: the caller's live canvas selection as a macro default source. The id is only
 * meaningful on this replica — the shells pass the token they actually selected, and
 * nothing is selected when it is not in the scene the caller has open.
 */
export function macroSelectionOf(client: ClientSync, tokenId: string | null | undefined): MacroSelection | null {
  if (!tokenId) return null;
  const scenes = client.store.getAll("scenes") as readonly SceneDocument[];
  for (const scene of scenes) {
    const token = scene.tokens.find((entry) => entry._id === tokenId);
    if (token) return macroSelection(token);
  }
  return null;
}

export function runChatMacro(client: ClientSync, macro: MacroDocument): void {
  if (macro.kind !== "chat") return; // script macros: M3 system API (D-079)
  const parsed = parseChatCommand(macro.command);
  if (
    parsed.kind === "roll" ||
    parsed.kind === "gmroll" ||
    parsed.kind === "blindroll" ||
    parsed.kind === "selfroll"
  ) {
    if (parsed.formula) client.roll(parsed.formula, parsed.kind);
    return;
  }
  const { message } = buildChatMessage({ author: client.user?.id ?? "", parsed });
  client.submit([{ kind: "create", coll: "messages", data: message }]);
}

/**
 * TR-12/MC-01: run a saved macro from the directory or a hotbar slot, by kind.
 * Chat macros keep their pure-chat path; an automation macro asks the **host** to
 * fire the graph it references — the client never sees that graph's id.
 */
export function runSavedMacro(
  client: ClientSync,
  macro: MacroDocument,
  args: Record<string, string | number | boolean> = {},
): { ok: boolean; error?: string; requestId?: string } {
  if (macro.kind === "automation" || macro.kind === "composite") {
    // The caller may track the request id to show the host's own result line. A
    // composite resolves its children on the host — no child id travels either, and
    // it takes no arguments because it declares no schema of its own.
    return { ok: true, requestId: client.invokeMacro(macro._id, { ...args }) };
  }
  if (macro.kind === "chat") {
    runChatMacro(client, macro);
    return { ok: true };
  }
  // Script/sequence/summon macros have their own surfaces (reviewed Worker,
  // FX timeline, summon picker); the command line says so instead of doing nothing.
  const label = { script: "script", sequence: "FX sequence", summon: "summon",
    fxPreset: "FX preset", composite: "composite" }[macro.kind];
  return { ok: false, error: `Cannot run ${label} macros from chat yet` };
}

/** The shell hooks a hotbar slot needs that are not the client's business. */
export interface MacroSlotHost {
  /** GM shell: open the macros window to collect a script macro's declared inputs. */
  onNeedsInput?: (() => void) | undefined;
  /** The caller's active scene, for a sequence macro (a player shell has one too). */
  activeSceneId?: (() => string | null) | undefined;
  /** D-388: the caller's selected token, for a macro input declared `from: "selected"`. */
  selection?: (() => MacroSelection | null) | undefined;
}

/**
 * MC-01: run the macro in a hotbar slot by kind — the same dispatch the directory
 * uses, plus the two kinds whose surfaces live in a shell (script, sequence). A
 * player's slot runs the identical path; the host decides what may actually fire.
 */
export function runMacroSlot(
  client: ClientSync,
  macro: MacroDocument,
  host: MacroSlotHost = {},
): { ok: boolean; error?: string; requestId?: string } {
  if (macro.kind === "chat") {
    runChatMacro(client, macro);
    return { ok: true };
  }
  if (macro.kind === "automation") {
    // D-388: a slot click binds the macro's own schema, so a declared selection default
    // simply works and a missing value is refused here — the caller's precise reason,
    // rather than the host's neutral one. Non-selection values need the run form.
    const inputs = macroAutomationInputs(macro);
    const bound = bindMacroArgs(inputs, "", host.selection?.() ?? null);
    if (!bound.ok) {
      if (inputs.some((field) => field.from !== "selected")) host.onNeedsInput?.();
      return { ok: false, error: bound.error };
    }
    return { ok: true, requestId: client.invokeMacro(macro._id, bound.args) };
  }
  if (macro.kind === "composite") return { ok: true, requestId: client.invokeMacro(macro._id) };
  if (macro.kind === "script") {
    if (macro.script?.inputs.some((field) => field.required)) {
      host.onNeedsInput?.();
      return { ok: false, error: "this macro needs its declared inputs" };
    }
    return { ok: true, requestId: client.requestMacro(macro._id) };
  }
  if (macro.kind === "sequence") {
    const sceneId = host.activeSceneId?.() ?? null;
    if (!sceneId) return { ok: false, error: "open a scene before running a sequence macro" };
    return { ok: true, requestId: client.requestSequence(macro._id, sceneId) };
  }
  return { ok: false, error: `Cannot run ${macro.kind} macros from a hotbar slot` };
}

/**
 * MC-02: the caller's own status line for a macro result. A graph may return a value; it is
 * shown to the invoker (a `gm`-audience value only reaches a GM invoker, and the host simply
 * omits it otherwise) and never becomes a chat message.
 */
export function macroResultText(msg: { ok: boolean; detail: string; result?: unknown }): string {
  const base = msg.ok ? msg.detail : `Refused: ${msg.detail}`;
  return msg.ok && msg.result !== undefined ? `${base} → ${String(msg.result)}` : base;
}

/** §10 defaults plus D-392's local player bindings share the core slot resolver. */
export { macroSlots } from "../../core/macroHotbar";
