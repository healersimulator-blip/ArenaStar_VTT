/**
 * D-295 (SQ-13/A10) — FX delivery: a preload plan, a bounded late-media policy,
 * and a report a viewer can actually read.
 *
 * The host stamps a cue with `atHostTime` and sends it `FX_LEAD_MS` ahead, so a
 * section that starts at `startMs` has lead time to fetch its media *before* the
 * table expects it. This module decides which assets are worth fetching early
 * (`fxPreloadPlan`), what a section may do when its bytes are not in hand at its
 * start (`lateMediaDecision`), and how to say so in one line (`summarizeDelivery`).
 * All of it is pure: the player owns sockets, timers and decoders, not policy.
 */
import type { ResolvedFxSection } from "./fx";
import type { FxDeliverySkips } from "./messages";
import type { AssetManifestEntry } from "./documents";
import { fxAssetFitness, type CanPlay, type FxAssetFitness } from "./fxPrefs";

export type FxMediaKind = "image" | "sound";

/** One media section, in timeline order, with the time it wants its bytes. */
export interface FxMediaCue {
  /** Index into the cue's own section list (the report points back at it). */
  index: number;
  kind: FxMediaKind;
  assetId: string;
  mime: string;
  startMs: number;
  durationMs: number;
}

/** Every image/sound section a cue will need, in order. Camera/text/wait carry no bytes. */
export function fxMediaCues(sections: readonly ResolvedFxSection[]): FxMediaCue[] {
  const out: FxMediaCue[] = [];
  sections.forEach((section, index) => {
    if (section.kind !== "image" && section.kind !== "sound") return;
    out.push({ index, kind: section.kind, assetId: section.assetId, mime: section.mime,
      startMs: section.startMs, durationMs: section.durationMs });
  });
  return out;
}

/**
 * When to start fetching each asset a timeline will need.
 *
 * `waitMs` is the delay before the prefetch starts, `aheadMs` the viewer's own
 * preload window: a section due in 800 ms with a 2 s window starts now (there is
 * only 800 ms of lead left), while one due in 20 s waits until exactly 2 s before
 * its cue — a request belongs to the cue that needs it, not to a queue the scene
 * load is also waiting on (§7 priority ladder). `aheadMs <= 0` turns preloading off,
 * which is the "lazily fetch otherwise" half of SQ-13: one entry per distinct asset,
 * in the order their fetches start.
 */
export function fxPreloadPlan(
  sections: readonly ResolvedFxSection[],
  options: { leadMs: number; aheadMs: number; include?: (media: FxMediaCue) => boolean },
): Array<{ assetId: string; mime: string; kind: FxMediaKind; waitMs: number }> {
  if (options.aheadMs <= 0) return [];
  const byAsset = new Map<string, { assetId: string; mime: string; kind: FxMediaKind; waitMs: number }>();
  for (const cue of fxMediaCues(sections)) {
    // A viewer may rule a cue out before it is due — a muted sound must not spend
    // bandwidth. The filter is a caller's policy; the plan stays a plan.
    if (options.include && !options.include(cue)) continue;
    // `cue.startMs` may be ≤ 0 (a section that begins with the timeline): the bytes
    // are needed the moment the cue starts, so only the transport lead is left.
    const available = options.leadMs + cue.startMs;
    const waitMs = Math.max(0, available - options.aheadMs);
    const existing = byAsset.get(cue.assetId);
    if (existing && existing.waitMs <= waitMs) continue; // the earliest need wins
    byAsset.set(cue.assetId, { assetId: cue.assetId, mime: cue.mime, kind: cue.kind, waitMs });
  }
  return [...byAsset.values()].sort((a, b) => a.waitMs - b.waitMs || a.assetId.localeCompare(b.assetId));
}

export type FxDeliveryState = "ready" | "late" | "skipped" | "cut" | "failed";
export type FxDeliveryReason =
  | "preload"          // bytes were fetched ahead of the cue
  | "not-ready"        // a slow client: the fetch had not landed when the section started
  | "missing"          // the registry has no such asset for this viewer
  | "unsupported-codec" // the browser refused the MIME before/while decoding
  | "muted"            // local "mute FX sound" preference
  | "reduced-motion"   // local "reduce motion" preference cut a camera cue short
  | "error";           // decode/playback threw

export interface FxDeliveryEntry {
  index: number;
  kind: ResolvedFxSection["kind"];
  state: FxDeliveryState;
  reason?: FxDeliveryReason;
  assetId?: string;
  /** How long after its scheduled start the cue actually became usable (ms, ≥ 0). */
  lateMs?: number;
  detail?: string;
}

export interface FxDeliveryReport {
  runId: string;
  sceneId: string;
  entries: FxDeliveryEntry[];
  /** `warn` when anything degraded, `info` when the timeline played as authored. */
  level: "info" | "warn";
  message: string;
}

/**
 * The late-media policy, applied at a section's start time. `lateMs` is how far past
 * its start the section already is; a section with no media in hand yet is "late".
 * `delay` plays it as soon as it can (the frame jumps to the right phase), `skip`
 * drops the cue so every viewer sees the same frames. Both report.
 */
export function lateMediaDecision(mode: "delay" | "skip", lateMs: number):
  { start: true } | { start: false; reason: FxDeliveryReason } {
  void lateMs; // the *policy* is what a late value selects; the report carries the number
  return mode === "delay" ? { start: true } : { start: false, reason: "not-ready" };
}

/** Human names for a report line; a table reads "sound", not "kind: sound". */
const KIND_LABEL: Record<string, string> = {
  image: "image", sound: "sound", text: "text", camera: "camera", wait: "wait",
};
const REASON_LABEL: Record<FxDeliveryReason, string> = {
  "preload": "preloaded", "not-ready": "not loaded in time", "missing": "missing media",
  "unsupported-codec": "unsupported format", "muted": "muted on this device",
  "reduced-motion": "cut by reduced motion", "error": "failed to play",
};

/**
 * One line for the viewer, or `null` when the timeline played exactly as authored
 * (no news is the right amount of news for an effect that worked).
 */
export function summarizeDelivery(
  entries: readonly FxDeliveryEntry[],
  name = "FX timeline",
): { level: "info" | "warn"; message: string } | null {
  const degraded = entries.filter((entry) => entry.state !== "ready");
  if (degraded.length === 0) return null;
  const parts = new Map<string, number>();
  for (const entry of degraded) {
    const label = `${KIND_LABEL[entry.kind] ?? entry.kind} ${
      entry.reason ? REASON_LABEL[entry.reason] : "degraded"}`;
    parts.set(label, (parts.get(label) ?? 0) + 1);
  }
  const detail = [...parts.entries()].map(([label, count]) =>
    count > 1 ? `${count}× ${label}` : label).join("; ");
  const late = degraded.map((entry) => entry.lateMs ?? 0).reduce((a, b) => Math.max(a, b), 0);
  const tail = late > 0 ? ` (up to ${Math.round(late)} ms late)` : "";
  return { level: "warn",
    message: `${name}: ${degraded.length} of ${entries.length} cue(s) degraded — ${detail}${tail}` };
}

/**
 * Authoring-time fitness (the wizard's side of SQ-13): what a save would ship that
 * this client cannot render, or that players cannot receive. `shared` reports
 * whether an asset is served to players at all — a scene-audience timeline that
 * references GM-only media is the "audience/entitlement mismatch" case, and it is
 * better said *before* the GM wonders why nothing appeared on the player's screen.
 */
export function fxFitnessIssues(
  sections: readonly ResolvedFxSection[],
  options: {
    entries: Readonly<Record<string, Pick<AssetManifestEntry, "mime" | "visibility"> | undefined>>;
    canPlay?: CanPlay | null;
    /** Asset visibility rule for the intended audience; omitted = do not check. */
    audience?: "scene" | "gm" | "caller";
  },
): string[] {
  const issues: string[] = [];
  const media = [...new Set(fxMediaCues(sections).map((cue) => cue.assetId))];
  for (const assetId of media) {
    const entry = options.entries[assetId];
    const mime = entry?.mime ?? "";
    const fitness: FxAssetFitness = fxAssetFitness(entry, mime, options.canPlay);
    if (fitness === "missing") issues.push(`${assetId.slice(0, 8)}… is not in this world's registry`);
    else if (fitness === "unsupported-codec") issues.push(`${entry?.mime ?? mime} cannot be decoded by this browser`);
    if (options.audience === "scene" && entry && entry.visibility === "gm") {
      issues.push(`${assetId.slice(0, 8)}… is GM-only media: a scene-audience timeline cannot reach players`);
    }
  }
  return issues;
}

/**
 * The requester's one line about a partial audience (SQ-13/A10). Counts only: the GM
 * learns the cue did not reach everyone and *why*, without the message naming a user
 * or a hidden document — an FX request must not become a membership query.
 */
export function summarizeSkips(
  skipped: FxDeliverySkips,
  recipients: number,
  name = "FX timeline",
): string | null {
  const total = skipped.audience + skipped.rights + skipped.anchor + skipped.media;
  if (total === 0) return null;
  const reasons: string[] = [];
  if (skipped.audience > 0) reasons.push(`${skipped.audience} outside its audience`);
  if (skipped.rights > 0) reasons.push(`${skipped.rights} without read rights`);
  if (skipped.anchor > 0) reasons.push(`${skipped.anchor} missing the source/target token`);
  if (skipped.media > 0) reasons.push(`${skipped.media} without media rights`);
  const reach = recipients === 0 ? "reached no one" : `reached ${recipients} viewer(s)`;
  return `${name}: ${reach} — ${total} skipped (${reasons.join(", ")})`;
}
