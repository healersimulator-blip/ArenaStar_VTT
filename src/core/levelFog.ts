/** Explicit fog namespaces. Legacy maps never seed every authored floor. */
export const LEVEL_FOG_FEATURE = "scene-level-fog-v1";
export function fogLevelIdError(value: unknown): string | null {
  return value === undefined || (typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value)) ? null : "Invalid fog level ID";
}
export function fogNamespace(sceneId: string, levelId?: string, userId?: string): string {
  return JSON.stringify([sceneId, levelId ?? null, userId ?? null]);
}

/** Reset epochs are opaque, host-created and shared by every user of one level. */
export const LEVEL_FOG_RESET_FEATURE = "scene-level-fog-reset-v1";
export function fogEpochError(value: unknown): string | null {
  return value === undefined || value === "" || (typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value)) ? null : "Invalid fog epoch";
}
export function fogVersionKey(sceneId: string, levelId?: string, userId?: string, epoch = ""): string {
  return JSON.stringify([fogNamespace(sceneId, levelId, userId), epoch]);
}
