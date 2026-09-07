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
