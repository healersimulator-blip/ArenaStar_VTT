/**
 * §10 chat-macro runner — shared by the macros window, the hotbar and the
 * 1-5 keybindings. Script macros are stored but not executed until the
 * system API lands (M3, D-079).
 */
import type { ClientSync } from "../../client/sync";
import type { MacroDocument } from "../../core/documents";
import { buildChatMessage, parseChatCommand } from "../../core/chat";

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
  if (macro.kind === "automation" || macro.kind === "composite")
    return { ok: true, requestId: client.invokeMacro(macro._id) };
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

/** Macros bound to a hotbar slot (flags.core.slot, §10). */
export function macroSlots(macros: readonly MacroDocument[]): Array<MacroDocument | null> {
  const slots: Array<MacroDocument | null> = [null, null, null, null, null];
  for (const m of macros) {
    const core = (m.flags as { core?: { slot?: unknown } }).core;
    const slot = typeof core?.slot === "number" ? core.slot : 0;
    if (slot >= 1 && slot <= 5) slots[slot - 1] = m;
  }
  return slots;
}
