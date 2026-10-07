import type { FxItemEvent } from "../../core/fxBinding";

/** Context supplied by a PF1e sheet action card to the shared GM FX-binding dialog. */
export type FxBindingPickerTarget =
  | { kind: "spell"; spellName: string }
  | { kind: "item"; actorId: string; itemId: string; event: FxItemEvent };
