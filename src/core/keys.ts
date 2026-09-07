/**
 * §10 keybindings — combo normalization + matching and the default map.
 * Combos are "Mod+Shift+KeyK"-style strings; `Mod` = Ctrl (⌘ later, §15).
 */
export interface ComboEvent {
  key: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

/** Normalize a keyboard event to a combo string ("Control+Shift+k"). */
export function comboOf(e: ComboEvent): string {
  const key =
    e.key === " " ? "Space" : e.key.length === 1 ? e.key.toLowerCase() : normalizeKey(e.key);
  const parts: string[] = [];
  if (e.ctrlKey) parts.push("Control");
  if (e.metaKey) parts.push("Meta");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  parts.push(key);
  return parts.join("+");
}

function normalizeKey(key: string): string {
  const map: Record<string, string> = {
    ArrowUp: "ArrowUp",
    ArrowDown: "ArrowDown",
    ArrowLeft: "ArrowLeft",
    ArrowRight: "ArrowRight",
    Escape: "Escape",
    Enter: "Enter",
    " ": "Space",
  };
  return map[key] ?? key;
}

/** Exact match of a combo string against an event. */
export function matches(combo: string, e: ComboEvent): boolean {
  return comboOf(e) === combo;
}

/** Default bindings (§10): hotbar 1-5, undo/redo, cycle tab. */
export const DEFAULT_BINDINGS: Readonly<Record<string, string>> = {
  "hotbar.1": "1",
  "hotbar.2": "2",
  "hotbar.3": "3",
  "hotbar.4": "4",
  "hotbar.5": "5",
  "edit.undo": "Control+z",
  "edit.redo": "Control+y",
};

/** Reverse lookup: combo → action (first match by insertion order). */
export function actionForCombo(
  combo: string,
  bindings: Readonly<Record<string, string>> = DEFAULT_BINDINGS,
): string | null {
  for (const [action, c] of Object.entries(bindings)) {
    if (c === combo) return action;
  }
  return null;
}

/** True when a key event targets an editable control (bindings must yield). */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || !el.tagName) return false;
  const tag = el.tagName.toUpperCase();
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable === true;
}
