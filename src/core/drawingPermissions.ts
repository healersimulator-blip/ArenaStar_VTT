import type { DrawingDocument } from "./documents";

/** Operation-level drawing permissions. UI checks are only a convenience; callers must use this. */
export function canDeleteDrawing(
  drawing: Pick<DrawingDocument, "ownership" | "flags">,
  userId: string,
  role: string,
): boolean {
  if (role === "GM" || role === "ASSISTANT") return true;
  const owner = drawing.flags.core?.createdBy;
  return owner === userId || drawing.ownership[userId] === 3;
}

export function canEraseAllDrawings(role: string): boolean {
  return role === "GM" || role === "ASSISTANT";
}
