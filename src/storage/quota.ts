/**
 * §8 storage health: navigator.storage.persist() request + quota reporting
 * for UI warnings. All probes are feature-detected (null = unavailable).
 */

export interface StorageStatus {
  /** StorageManager available at all. */
  supported: boolean;
  /** persist() result, or current persisted state; null = unknown. */
  persisted: boolean | null;
  usage: number | null;
  quota: number | null;
}

export async function requestPersistence(): Promise<boolean | null> {
  const nav = globalThis.navigator as
    | { storage?: { persist?: () => Promise<boolean>; persisted?: () => Promise<boolean> } }
    | undefined;
  if (typeof nav?.storage?.persist !== "function") return null;
  try {
    const already = (await nav.storage.persisted?.()) ?? false;
    return already || (await nav.storage.persist());
  } catch {
    return null;
  }
}

export async function queryStorageStatus(): Promise<StorageStatus> {
  const nav = globalThis.navigator as
    | {
        storage?: {
          persisted?: () => Promise<boolean>;
          estimate?: () => Promise<{ usage?: number; quota?: number }>;
        };
      }
    | undefined;
  if (!nav?.storage || typeof nav.storage.persisted !== "function") {
    return { supported: false, persisted: null, usage: null, quota: null };
  }
  try {
    const persisted = await nav.storage.persisted();
    const estimate = (await nav.storage.estimate?.()) ?? {};
    return {
      supported: true,
      persisted,
      usage: estimate.usage ?? null,
      quota: estimate.quota ?? null,
    };
  } catch {
    return { supported: true, persisted: null, usage: null, quota: null };
  }
}

/** UI warning rule (§8 quota warnings): warn under 10 % free or 200 MB left. */
export function evaluateQuotaWarning(status: StorageStatus): string | null {
  if (!status.supported || status.usage === null || status.quota === null) return null;
  const free = status.quota - status.usage;
  if (status.quota > 0 && status.usage / status.quota > 0.9) {
    return `Storage almost full (${(free / 1_048_576).toFixed(0)} MB free) — export a world backup soon.`;
  }
  if (free < 200 * 1_048_576) {
    return `Low storage: ${(free / 1_048_576).toFixed(0)} MB free.`;
  }
  return null;
}
