/** Device-local, non-secret preferences. Never replicated/exported with a world. */
export interface CloudPreferences {
  destination: "google" | "github";
  mode: "remembered" | "temporary";
  repository: string;
  maxMiB: number;
}
export const CLOUD_PREFS_KEY = "vtt.cloud.preferences.v2";
export const DEFAULT_CLOUD_PREFERENCES: CloudPreferences = {
  destination: "google",
  mode: "remembered",
  repository: "",
  maxMiB: 512,
};
export function validateBackupLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 2048)
    throw new Error(
      "Choose a whole number from 0 to 2048 MiB. Zero means no additional cloud cap.",
    );
  return value;
}
export function loadCloudPreferences(): CloudPreferences {
  try {
    const raw = JSON.parse(
      globalThis.localStorage?.getItem(CLOUD_PREFS_KEY) ?? "null",
    ) as Partial<CloudPreferences> | null;
    if (!raw) return { ...DEFAULT_CLOUD_PREFERENCES };
    return {
      destination: raw.destination === "github" ? "github" : "google",
      mode: raw.mode === "temporary" ? "temporary" : "remembered",
      repository:
        typeof raw.repository === "string" ? raw.repository.slice(0, 200) : "",
      maxMiB: validateBackupLimit(raw.maxMiB ?? 512),
    };
  } catch {
    return { ...DEFAULT_CLOUD_PREFERENCES };
  }
}
export function saveCloudPreferences(prefs: CloudPreferences): void {
  validateBackupLimit(prefs.maxMiB);
  try {
    globalThis.localStorage?.setItem(CLOUD_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* Memory-only settings still work. */
  }
}
export function assertBackupSize(bytes: number, maxBytes: number): void {
  if (!Number.isSafeInteger(bytes) || bytes < 1)
    throw new Error("Invalid backup size.");
  if (maxBytes > 0 && bytes > maxBytes)
    throw new Error(
      `Backup exceeds your ${Math.round(maxBytes / 1048576)} MiB limit. Increase it in Cloud backups, or use local export.`,
    );
}
