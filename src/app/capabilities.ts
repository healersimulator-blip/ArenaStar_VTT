/**
 * Runtime capability detection (§0 bootstrap screen, §15 file:// support).
 * Pure, defensive (safe in Node, browsers, workers): every probe is feature-detected.
 * Later units reuse this to warn before hosting/joining when a required API is missing.
 */
export interface CapabilityReport {
  webcrypto: boolean;
  indexedDB: boolean;
  opfs: boolean;
  webrtc: boolean;
  webworker: boolean;
  cacheApi: boolean;
  secureContext: boolean;
}

export function detectCapabilities(): CapabilityReport {
  const g = globalThis as {
    crypto?: { subtle?: unknown };
    indexedDB?: unknown;
    RTCPeerConnection?: unknown;
    Worker?: unknown;
    caches?: unknown;
    isSecureContext?: boolean;
    navigator?: { storage?: { getDirectory?: unknown } };
  };
  return {
    webcrypto: typeof g.crypto?.subtle === "object" && g.crypto?.subtle !== null,
    indexedDB: typeof g.indexedDB === "object",
    opfs: typeof g.navigator?.storage?.getDirectory === "function",
    webrtc: typeof g.RTCPeerConnection === "function",
    webworker: typeof g.Worker === "function",
    cacheApi: typeof g.caches === "object",
    secureContext: g.isSecureContext === true,
  };
}
