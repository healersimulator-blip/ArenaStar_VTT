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
import type { FxDeliverySkips, FxMediaAckState } from "./messages";
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
  targeting: { targeted?: number; empty?: number } = {},
): string | null {
  const total = skipped.audience + skipped.rights + skipped.anchor + skipped.media;
  const targeted = targeting.targeted ?? 0;
  const empty = targeting.empty ?? 0;
  // D-303: a run that reached everyone but *reduced* some payloads (or silenced them
  // entirely) still needs explaining — otherwise the author never learns whether the
  // targeting they set did anything, and a player hearing nothing looks like a bug.
  if (total === 0 && targeted === 0 && empty === 0) return null;
  const reasons: string[] = [];
  if (skipped.audience > 0) reasons.push(`${skipped.audience} outside its audience`);
  if (skipped.rights > 0) reasons.push(`${skipped.rights} without read rights`);
  if (skipped.anchor > 0) reasons.push(`${skipped.anchor} missing the source/target token`);
  if (skipped.media > 0) reasons.push(`${skipped.media} without media rights`);
  if (targeted > 0) reasons.push(`${targeted} saw it without its targeted sections`);
  if (empty > 0) reasons.push(`${empty} left with none of it`);
  const reach = recipients === 0 ? "reached no one" : `reached ${recipients} viewer(s)`;
  const skippedText = total > 0 ? `${total} skipped (${reasons.join(", ")})` : reasons.join(", ");
  return `${name}: ${reach} — ${skippedText}`;
}

// ─── D-308: the table's own answer about the media (SQ-13's second half) ──────
//
// D-295 answered "who was *entitled* to this cue" before it went out. That is not the
// same question as "will the table actually see it": bytes still have to arrive, and a
// browser still has to decode them. This half is the viewers' side of the report, and
// it is deliberately three counts per asset rather than a list of names — the GM learns
// that *something* did not reach the table and what to fix, without a socket payload
// becoming a membership query (the same rule `summarizeSkips` follows).

/**
 * The state a viewer currently reports for one asset. Deliberately **the latest** ack, not
 * the worst one: a viewer that failed to fetch at cue start and succeeded when the section
 * actually needed the bytes has the media, and a report that kept saying "failed" would be
 * lying about the table's present. The reverse — a decode failure after a happy prefetch —
 * arrives later, so it wins too. A report that was already sent is corrected instead
 * (`FxMediaReport.corrected`), and only when the set of viewers *lacking* media changes.
 */
export type FxMediaAckStates = ReadonlyMap<string, FxMediaAckState>;

/** One asset of a run, as the requester's own timeline numbers it. */
export interface FxMediaReportEntry {
  /** Index into the cue's own section list — the numbering the author sees. */
  index: number;
  kind: "image" | "sound";
  mime: string;
  ready: number;
  late: number;
  failed: number;
  unsupported: number;
  /** Recipients that have said nothing about this asset yet. */
  silent: number;
}

export interface FxMediaReport {
  /** One entry per distinct asset the run uses, in timeline order. */
  assets: FxMediaReportEntry[];
  /** Sessions the cue was fanned out to. */
  viewers: number;
  /** How many of them have spoken about at least one asset — the progress half. */
  spoke: number;
  /** Every viewer answered for every asset: the report is final, not a snapshot. */
  complete: boolean;
  /** The slowest successful fetch among the `ready` acks that had to fetch (ms). */
  slowestReadyMs?: number;
  /** A **second** (and last) line for this run: an early answer changed after the fact. */
  corrected?: boolean;
}

/** What the host knows about one run's media: acks per session, folded to states. */
export interface FxMediaAckRecord {
  /** sessionId → (assetId → the worst state that session has reported). */
  bySession: ReadonlyMap<string, ReadonlyMap<string, FxMediaAckState>>;
  /** sessionId → the fetch time (ms) it reported for an asset it had to fetch. */
  fetchMs?: ReadonlyMap<string, ReadonlyMap<string, number>>;
}

/**
 * Fold the acks into the report the requester reads. `recipients` is the number of
 * sessions the cue reached; a recipient that has said nothing about an asset is
 * `silent` for it, which is the honest word for "still fetching, or gone".
 */
export function fxMediaReport(
  assets: ReadonlyArray<{ assetId: string; index: number; kind: "image" | "sound"; mime: string }>,
  recipients: number,
  acks: FxMediaAckRecord,
  options: { corrected?: boolean } = {},
): FxMediaReport {
  const entries: FxMediaReportEntry[] = [];
  let spoke = 0;
  let slowestReadyMs = 0;
  let answered = 0;
  for (const asset of assets) {
    const entry: FxMediaReportEntry = { index: asset.index, kind: asset.kind, mime: asset.mime,
      ready: 0, late: 0, failed: 0, unsupported: 0, silent: 0 };
    let counted = 0;
    for (const [sessionId, states] of acks.bySession) {
      const state = states.get(asset.assetId);
      if (state === undefined) continue;
      counted++;
      answered++;
      entry[state] += 1;
      if (state === "ready")
        slowestReadyMs = Math.max(slowestReadyMs, acks.fetchMs?.get(sessionId)?.get(asset.assetId) ?? 0);
    }
    // A viewer that has said nothing *at all* is not in the ack map: it is silent about
    // every asset, which is the honest word for "still fetching, or gone".
    entry.silent = Math.max(0, recipients - counted);
    entries.push(entry);
  }
  for (const states of acks.bySession.values()) if (states.size > 0) spoke++;
  return { assets: entries, viewers: recipients, spoke,
    complete: answered === recipients * assets.length,
    ...(slowestReadyMs > 0 ? { slowestReadyMs: Math.round(slowestReadyMs) } : {}),
    ...(options.corrected ? { corrected: true } : {}) };
}

/** A viewer lacks this asset for a reason it *reported* — the urgent half of a report. */
export function mediaLacking(entry: FxMediaReportEntry): number {
  return entry.failed + entry.unsupported + entry.late;
}

/**
 * The one line the requester gets. `null` is never returned: unlike a viewer's own
 * unsolicited report, this one was asked for, so an all-clear is news too ("media in
 * hand for everybody" is the answer to the GM's question, not noise).
 */
export function summarizeMedia(
  report: FxMediaReport,
  name = "FX timeline",
): { level: "info" | "warn"; message: string } {
  const tail = report.corrected ? " (corrected)" : "";
  const affected = (entry: FxMediaReportEntry): number => mediaLacking(entry) + entry.silent;
  const worst = [...report.assets].sort((a, b) =>
    affected(b) - affected(a) || mediaLacking(b) - mediaLacking(a) || a.index - b.index)[0];
  const lacking = worst ? mediaLacking(worst) : 0;
  if (!worst || (lacking === 0 && worst.silent === 0)) {
    const shape = `${report.assets.length} asset(s) × ${report.viewers} viewer(s)`;
    const slow = report.slowestReadyMs !== undefined ? `; slowest fetch ${report.slowestReadyMs} ms` : "";
    return { level: "info",
      message: `${name}: media in hand — every viewer holds all ${shape}${slow}${tail}` };
  }
  const parts: string[] = [];
  if (worst.unsupported > 0) parts.push(`${worst.unsupported} cannot decode this format`);
  if (worst.failed > 0) parts.push(`${worst.failed} failed to load`);
  if (worst.late > 0) parts.push(`started late for ${worst.late}`);
  if (worst.silent > 0)
    parts.push(lacking > 0 ? `${worst.silent} have not reported yet` : `no word from ${worst.silent}`);
  const more = report.assets.filter((entry) => affected(entry) > 0).length - 1;
  const also = more > 0 ? `; ${more} more asset(s) affected` : "";
  // The asset is named by the requester's own section number: the host sends no asset
  // identifier, so the author counts the section in the timeline they wrote.
  const headline = lacking > 0
    ? `media not in hand for ${lacking + worst.silent} of ${report.viewers} viewer(s)`
    : `no answer yet for ${worst.silent} of ${report.viewers} viewer(s)`;
  return { level: "warn",
    message: `${name}: ${headline} — section ${worst.index + 1} (${worst.kind}, ${worst.mime}): ` +
      `${parts.join("; ")}${also}${tail}` };
}
