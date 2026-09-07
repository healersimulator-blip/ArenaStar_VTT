/**
 * §7 audio — pure clock-sync and playlist math.
 *
 * NTP-style offset (ping/pong): the client stamps t0, the host t1 (recv) and
 * t2 (reply), the client t3 (recv). With symmetric latency:
 *   offset = host − client = ((t1 − t0) + (t2 − t3)) / 2
 *   rtt    = t3 − t0
 * The best estimate is the sample with the LOWEST rtt (least asymmetry).
 */

export interface ClockSample {
  t0: number;
  t1: number;
  t2: number;
  t3: number;
}

export interface ClockEstimate {
  offsetMs: number;
  rttMs: number;
}

/** Best (lowest-RTT) offset estimate across samples; null when none. */
export function estimateClockOffset(samples: readonly ClockSample[]): ClockEstimate | null {
  if (samples.length === 0) return null;
  let best: ClockEstimate | null = null;
  for (const s of samples) {
    const rtt = s.t3 - s.t0;
    const offset = (s.t1 - s.t0 + (s.t2 - s.t3)) / 2;
    if (!best || rtt < best.rttMs) best = { offsetMs: offset, rttMs: rtt };
  }
  return best;
}

/** Approximate host clock reading for a client moment (offset = host − client). */
export function hostTimeFromClient(clientNow: number, offsetMs: number): number {
  return clientNow + offsetMs;
}

/**
 * How long a client should wait before starting playback scheduled at
 * `atHostTime` (host clock). Negative → the moment already passed (start now).
 */
export function scheduleDelayMs(clientNow: number, offsetMs: number, atHostTime: number): number {
  return atHostTime - offsetMs - clientNow;
}

// ─── playlists ───────────────────────────────────────────────────────────────

/** Playlist playback modes (PlaylistDocument.mode, §4 string field — D-078). */
export type PlaylistMode = "off" | "sequential" | "loop" | "shuffle";

export const PLAYLIST_MODES: readonly PlaylistMode[] = ["off", "sequential", "loop", "shuffle"];

/**
 * Next sound after `currentId` finishes under the mode:
 *   off        → none (the panel stops)
 *   sequential → next in list; none at the end
 *   loop       → next in list, wrapping to the first
 *   shuffle    → a uniform random OTHER sound (single-sound lists wrap to it)
 */
export function nextPlaylistSound(
  sounds: readonly { _id: string }[],
  currentId: string | null,
  mode: PlaylistMode,
  rand: () => number = Math.random,
): string | null {
  if (sounds.length === 0) return null;
  const ids = sounds.map((s) => s._id);
  const idx = currentId === null ? -1 : ids.indexOf(currentId);
  switch (mode) {
    case "off":
      return null;
    case "sequential": {
      if (idx < 0) return ids[0] ?? null;
      return ids[idx + 1] ?? null;
    }
    case "loop": {
      if (idx < 0) return ids[0] ?? null;
      return ids[(idx + 1) % ids.length] ?? null;
    }
    case "shuffle": {
      if (ids.length === 1) return ids[0] ?? null;
      let pick = idx;
      for (let guard = 0; guard < 8 && pick === idx; guard++) {
        pick = Math.min(ids.length - 1, Math.floor(rand() * ids.length));
      }
      if (pick === idx) pick = (idx + 1) % ids.length;
      return ids[pick] ?? null;
    }
  }
}

/** Parse a playlist mode string from a document (unknown → "off"). */
export function parsePlaylistMode(mode: string): PlaylistMode {
  return (PLAYLIST_MODES as readonly string[]).includes(mode) ? (mode as PlaylistMode) : "off";
}
