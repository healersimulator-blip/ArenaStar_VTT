/**
 * Versioned, data-only FX timeline. Visual sections have NO mechanical effect;
 * a host validates the definition, resolves anchors and chooses recipients.
 * Times are offsets from one host-clock timestamp, so lanes naturally overlap.
 * This is the first sequence format, not the full Sequencer action catalogue.
 */
import type { SceneDocument, TokenDocument } from "./documents";
import { isSoundChannel, type FxSoundChannel } from "./fxSound";

export type FxAnchor = { kind: "point"; x: number; y: number } | { kind: "source" | "target" };

/** Explicit, independent rights declarations for user-provided FX media. */
export interface FxImportPermissions {
  /** Serving media bytes to connected players also requires appropriate permission. */
  shareWithPlayers: boolean;
  /** Embedding bytes in a downloadable world archive needs redistribution rights. */
  includeInWorldFile: boolean;
}
export type FxLayerName = "belowTokens" | "aboveTokens";
export type FxEasing = "linear" | "easeIn" | "easeOut" | "easeInOut";
const EASINGS: readonly FxEasing[] = ["linear", "easeIn", "easeOut", "easeInOut"];
/** Validation reads untyped JSON: narrow rather than cast an arbitrary value. */
const isEasing = (value: unknown): value is FxEasing =>
  typeof value === "string" && (EASINGS as readonly string[]).includes(value);

/**
 * The one easing curve both the canvas visuals and the camera use, so a section
 * cannot move at one rate while its audition moves at another (WZ-09).
 */
export function fxEase(easing: FxEasing | undefined, progress: number): number {
  const phase = Math.min(1, Math.max(0, progress));
  if (easing === "easeIn") return phase * phase;
  if (easing === "easeOut") return 1 - (1 - phase) ** 2;
  if (easing === "easeInOut")
    return phase < 0.5 ? 2 * phase * phase : 1 - (-2 * phase + 2) ** 2 / 2;
  return phase;
}

interface FxBase {
  id: string;
  startMs: number;
  durationMs: number;
  /** One-shot media replays; distinct from located-section `repeats`, which
   * controls motion cycles inside a SINGLE playback window. Waits/persistent
   * loops cannot use this. Host expands into bounded clock-aligned cues. */
  repeatCount?: number;
  repeatDelayMs?: number;
}
interface FxLocated extends FxBase {
  at: FxAnchor;
  /** Local scale, not world/grid size. */
  scale?: number;
  opacity?: number;
  rotation?: number;
  fadeInMs?: number;
  fadeOutMs?: number;
  layer?: FxLayerName;
  /** Follow visible source/target token anchors on each recipient's canvas. Only host-resolved IDs travel. */
  follow?: boolean;
  /** Host-resolved destination: tween from `at`, or stretch an image along the segment. */
  to?: FxAnchor;
  easing?: FxEasing;
  /** Number of movement cycles inside this section's fixed duration. */
  repeats?: number;
}
/**
 * A camera section claims the **viewer's own view** for its duration. It is not a
 * document change: the host resolves and authorizes the destination exactly as it
 * does for any other anchor, and each recipient's client moves only its own
 * camera. Two rules follow from that, and both are enforced here rather than in a
 * client: a camera cue can never loop (a persistent timeline must not hold a view
 * forever), and it can never replay.
 */
interface FxCameraBase extends FxBase {
  kind: "camera";
}
/** Centre the viewport on `to` over `durationMs`; `zoom` optionally ends at a new scale. */
export interface FxCameraPanSection extends FxCameraBase {
  mode: "pan";
  to: FxAnchor;
  easing?: FxEasing;
  /** Absolute world zoom at the END of the pan (0.1–10); absent keeps the current scale. */
  zoom?: number;
}
/** Bounded, decaying shake around wherever the camera already is. */
export interface FxCameraShakeSection extends FxCameraBase {
  mode: "shake";
  /** Amplitude 0.05–1 of a bounded screen offset; decays to zero by the last frame. */
  intensity: number;
}
export type FxCameraSection = FxCameraPanSection | FxCameraShakeSection;

export type FxSection =
  | (FxLocated & { kind: "image"; assetId: string; stretch?: boolean; tint?: string }) // image/* and alpha video
  | (FxLocated & { kind: "text"; text: string; color?: string })
  | (FxBase & { kind: "sound"; assetId: string; volume?: number;
      /** Which fader this sound belongs to (viewer-local mix, D-297). */
      channel?: FxSoundChannel;
      /** Ramp 0→1 over this many ms at the start of the section. */
      fadeInMs?: number;
      /** Ramp 1→0 over the last `fadeOutMs` of the section (ignored by a persistent loop). */
      fadeOutMs?: number })
  | FxCameraSection
  | (FxBase & { kind: "wait" });

export interface FxSequence {
  version: 1;
  /** Overlap on the timeline = parallel; different startMs values = ordered. */
  sections: FxSection[];
  audience?: "scene" | "gm" | "caller";
  /** Host-owned named instance: each visual/audio section loops until explicitly stopped. */
  persistent?: boolean;
}

export type ResolvedFxSection =
  | (Omit<Extract<FxSection, { kind: "image" }>, "at" | "to" | "repeatCount" | "repeatDelayMs"> & { x: number; y: number; toX?: number; toY?: number; mime: string; followTokenId?: string; followToTokenId?: string })
  | (Omit<Extract<FxSection, { kind: "text" }>, "at" | "to" | "repeatCount" | "repeatDelayMs"> & { x: number; y: number; toX?: number; toY?: number; followTokenId?: string; followToTokenId?: string })
  | (Omit<Extract<FxSection, { kind: "sound" }>, "repeatCount" | "repeatDelayMs"> & { mime: string })
  /** A pan carries its **host-resolved** destination; a shake carries no anchor at all. */
  | (Omit<FxCameraPanSection, "to" | "repeatCount" | "repeatDelayMs"> & { toX: number; toY: number })
  | Omit<FxCameraShakeSection, "repeatCount" | "repeatDelayMs">
  | Omit<Extract<FxSection, { kind: "wait" }>, "repeatCount" | "repeatDelayMs">;

const MAX_SECTIONS = 48;
/** A timeline that moved the view eight times would be a slideshow, not an effect. */
const MAX_CAMERA_SECTIONS = 8;
const MIN_CAMERA_MS = 100;
const MAX_PLAYBACKS = 64;
const MAX_TIMELINE_MS = 60_000;
const MAX_SECTION_MS = 30_000;
const HASH = /^[a-f0-9]{64}$/;
const HEX_COLOR = /^#[a-f0-9]{6}$/i;
const VISUAL_MIME = new Set([
  "image/png", "image/jpeg", "image/webp", "image/gif", "image/avif",
  "video/webm", "video/mp4",
]);
const AUDIO_MIME = new Set(["audio/mpeg", "audio/mp3", "audio/wav", "audio/ogg", "audio/webm", "audio/mp4", "audio/aac"]);

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function inRange(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}
function validAnchor(at: unknown): at is FxAnchor {
  return isObject(at) && (
    (at.kind === "point" && Object.keys(at).every((k) => ["kind", "x", "y"].includes(k)) &&
      inRange(at.x, 0, 1_000_000) && inRange(at.y, 0, 1_000_000)) ||
    ((at.kind === "source" || at.kind === "target") && Object.keys(at).length === 1)
  );
}

export function validateFxSequence(value: unknown): { ok: true; sequence: FxSequence } | { ok: false; error: string } {
  if (!isObject(value) || value.version !== 1 || !Array.isArray(value.sections) ||
    value.sections.length < 1 || value.sections.length > MAX_SECTIONS ||
    (value.audience !== undefined && !["scene", "gm", "caller"].includes(String(value.audience))) ||
    (value.persistent !== undefined && typeof value.persistent !== "boolean")) {
    return { ok: false, error: "FX sequence needs version 1, an audience, persistence flag and 1–48 sections" };
  }
  if (Object.keys(value).some((key) => !["version", "sections", "audience", "persistent"].includes(key))) {
    return { ok: false, error: "unknown FX sequence field" };
  }
  if (value.persistent && (value.sections.length > 16 || value.sections.every((step) => step.kind === "wait") ||
      value.sections.some((step) => step.kind !== "wait" && step.durationMs < 250))) {
    return { ok: false, error: "persistent FX needs a media section of at least 250 ms and at most 16 sections" };
  }
  const ids = new Set<string>();
  let playbackCount = 0;
  let cameraCount = 0;
  for (const section of value.sections as unknown[]) {
    if (!isObject(section) || typeof section.id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(section.id) || ids.has(section.id) ||
      !inRange(section.startMs, 0, MAX_TIMELINE_MS) || !inRange(section.durationMs, 0, MAX_SECTION_MS) ||
      section.startMs + section.durationMs > MAX_TIMELINE_MS) {
      return { ok: false, error: "FX section IDs, start and duration must be unique and bounded" };
    }
    ids.add(section.id);
    // A camera cue is not media: it has no replays (a view claim that repeated
    // itself would be a stuck frame), so its repeat fields are unknown fields.
    const repeatFields = section.kind === "wait" || section.kind === "camera"
      ? [] : ["repeatCount", "repeatDelayMs"];
    const fields = section.kind === "sound" ? ["assetId", "volume", "channel", "fadeInMs", "fadeOutMs"] :
      section.kind === "image" ? ["assetId", "at", "to", "stretch", "tint", "easing", "repeats", "scale", "opacity", "rotation", "fadeInMs", "fadeOutMs", "layer", "follow"] :
      section.kind === "text" ? ["text", "color", "at", "to", "easing", "repeats", "scale", "opacity", "rotation", "fadeInMs", "fadeOutMs", "layer", "follow"] :
      section.kind === "camera" ? ["mode", "to", "easing", "zoom", "intensity"] : [];
    if (Object.keys(section).some((key) => !["id", "kind", "startMs", "durationMs", ...fields, ...repeatFields].includes(key)) ||
      (section.kind !== "wait" && section.durationMs === 0)) {
      return { ok: false, error: "unknown FX section field or zero-duration media" };
    }
    if (section.kind === "camera") {
      if (value.persistent)
        return { ok: false, error: "a persistent timeline cannot move a viewer's camera" };
      if ((cameraCount += 1) > MAX_CAMERA_SECTIONS)
        return { ok: false, error: "at most 8 camera sections per timeline" };
      if (section.durationMs < MIN_CAMERA_MS)
        return { ok: false, error: "camera sections need at least 100 ms" };
      if (section.mode === "pan") {
        if (!validAnchor(section.to) || section.intensity !== undefined ||
            (section.easing !== undefined && !isEasing(section.easing)) ||
            (section.zoom !== undefined && !inRange(section.zoom, 0.1, 10)))
          return { ok: false, error: "a camera pan needs a destination anchor, optional easing and zoom 0.1–10" };
      } else if (section.mode === "shake") {
        if (section.to !== undefined || section.zoom !== undefined || section.easing !== undefined ||
            !inRange(section.intensity, 0.05, 1))
          return { ok: false, error: "a camera shake needs an intensity 0.05–1 and no destination" };
      } else return { ok: false, error: "camera sections are either a pan or a shake" };
      continue;
    }
    if (section.kind === "wait") continue;
    const repeatCount = section.repeatCount === undefined ? 1 : section.repeatCount;
    if (typeof repeatCount !== "number" || !Number.isSafeInteger(repeatCount) ||
        (section.repeatCount !== undefined && !inRange(repeatCount, 2, 8)) ||
        (section.repeatDelayMs !== undefined && (section.repeatCount === undefined ||
          !Number.isSafeInteger(section.repeatDelayMs) || !inRange(section.repeatDelayMs, 0, 30_000))) ||
        (value.persistent && section.repeatCount !== undefined) ||
        section.startMs + repeatCount * section.durationMs +
          (repeatCount - 1) * (typeof section.repeatDelayMs === "number" ? section.repeatDelayMs : 0) > MAX_TIMELINE_MS ||
        (playbackCount += repeatCount) > MAX_PLAYBACKS) {
      return { ok: false, error: "FX replays require 2–8 one-shot plays, bounded pause and at most 64 total cues within 60 s" };
    }
    if (section.kind === "sound") {
      if (typeof section.assetId !== "string" || !HASH.test(section.assetId) ||
        (section.volume !== undefined && !inRange(section.volume, 0, 1))) {
        return { ok: false, error: "FX sound needs an imported hash and volume 0–1" };
      }
      // A channel is a closed set, not a free-text field: an unknown one would be
      // silently treated as an effect everywhere and mix wrongly by accident.
      if (section.channel !== undefined && !isSoundChannel(section.channel))
        return { ok: false, error: "FX sound channel must be effects, music, ambience or voice" };
      // Fades are bounded by the section itself, like an image's: a ramp longer than
      // the cue is a fade that never finishes.
      if ((section.fadeInMs !== undefined && !inRange(section.fadeInMs, 0, section.durationMs)) ||
        (section.fadeOutMs !== undefined && !inRange(section.fadeOutMs, 0, section.durationMs)))
        return { ok: false, error: "FX sound fades must fit inside the section duration" };
      continue;
    }
    if ((section.kind !== "image" && section.kind !== "text") || !validAnchor(section.at) ||
      (section.to !== undefined && !validAnchor(section.to)) ||
      (section.easing !== undefined && !isEasing(section.easing)) ||
      (section.repeats !== undefined && (!Number.isInteger(section.repeats) || !inRange(section.repeats, 1, 20) || !section.to)) ||
      (section.layer !== undefined && section.layer !== "belowTokens" && section.layer !== "aboveTokens") ||
      (section.follow !== undefined && (typeof section.follow !== "boolean" ||
        section.follow && section.at.kind === "point" && (!section.to || section.to.kind === "point"))) ||
      (section.scale !== undefined && !inRange(section.scale, 0.05, 10)) ||
      (section.opacity !== undefined && !inRange(section.opacity, 0, 1)) ||
      (section.rotation !== undefined && !inRange(section.rotation, -360, 360)) ||
      (section.fadeInMs !== undefined && !inRange(section.fadeInMs, 0, section.durationMs)) ||
      (section.fadeOutMs !== undefined && !inRange(section.fadeOutMs, 0, section.durationMs))) {
      return { ok: false, error: "FX image/text needs a valid anchor, layer, fade and transform" };
    }
    if (section.kind === "image" &&
        (typeof section.assetId !== "string" || !HASH.test(section.assetId) ||
          (section.stretch !== undefined && (typeof section.stretch !== "boolean" || section.stretch && !section.to)) ||
          (section.stretch && section.repeats !== undefined) ||
          (section.tint !== undefined && (typeof section.tint !== "string" || !HEX_COLOR.test(section.tint))))) {
      return { ok: false, error: "FX image needs an imported hash, valid tint and destination for stretch" };
    }
    if (section.kind === "text" && (
      typeof section.text !== "string" || section.text.length < 1 || section.text.length > 256 ||
      (section.color !== undefined && (typeof section.color !== "string" || !HEX_COLOR.test(section.color)))
    )) return { ok: false, error: "FX text needs 1–256 characters and an optional hex color" };
  }
  return { ok: true, sequence: value as unknown as FxSequence };
}

/** Resolve all anchors ON THE HOST using its committed scene state. */
export function resolveFxSequence(
  sequence: FxSequence,
  scene: SceneDocument,
  source: TokenDocument | undefined,
  target: TokenDocument | undefined,
  mimeOf: (assetId: string) => string | undefined,
): { ok: true; sections: ResolvedFxSection[] } | { ok: false; error: string } {
  const validated = validateFxSequence(sequence);
  if (!validated.ok) return validated;
  const sections: ResolvedFxSection[] = [];
  for (const section of sequence.sections) {
    if (section.kind === "wait") { sections.push(section); continue; }
    if (section.kind === "camera" && section.mode === "shake") {
      const { repeatCount: _count, repeatDelayMs: _gap, ...projected } = section;
      void _count; void _gap;
      sections.push(projected);
      continue;
    }
    if (section.kind === "sound") {
      const mime = mimeOf(section.assetId);
      if (!mime || !AUDIO_MIME.has(mime)) return { ok: false, error: `missing/unsupported sound: ${section.assetId}` };
      const { repeatCount: _count, repeatDelayMs: _gap, ...projected } = section;
      void _count; void _gap;
      sections.push({ ...projected, mime });
      continue;
    }
    const anchor = (at: FxAnchor): { ok: true; x: number; y: number } | { ok: false; error: string } => {
      let x: number, y: number;
      if (at.kind === "point") ({ x, y } = at);
      else {
        const token = at.kind === "source" ? source : target;
        if (!token) return { ok: false, error: `FX ${at.kind} token is required` };
        // TokenDocument x/y are already the center (see tokenRect); do not
        // offset twice or a saved aura jumps half a token away on playback.
        x = token.x;
        y = token.y;
      }
      if (x < 0 || y < 0 || x > scene.width || y > scene.height)
        return { ok: false, error: "FX anchor lies outside the scene" };
      return { ok: true, x, y };
    };
    if (section.kind === "camera") {
      // The host, never the client, decides where a pan may land — same anchor
      // function, same scene bounds, same refusal as every other cue.
      const destination = anchor(section.to);
      if (!destination.ok) return destination;
      const { to: _to, repeatCount: _count, repeatDelayMs: _gap, ...projected } = section;
      void _to; void _count; void _gap;
      sections.push({ ...projected, toX: destination.x, toY: destination.y });
      continue;
    }
    const start = anchor(section.at);
    if (!start.ok) return start;
    const destination = section.to ? anchor(section.to) : null;
    if (destination && !destination.ok) return destination;
    // Only explicitly followed, already-authorized token IDs travel to
    // recipients. Other anchors remain frozen at host-approved coordinates.
    // The host rechecks both tokens' visibility on EVERY commit/replay.
    const followed = (at: FxAnchor): string | undefined =>
      at.kind === "source" ? source?._id : at.kind === "target" ? target?._id : undefined;
    const fromId = section.follow ? followed(section.at) : undefined;
    const toId = section.follow && section.to ? followed(section.to) : undefined;
    const coords = { x: start.x, y: start.y,
      ...(destination?.ok ? { toX: destination.x, toY: destination.y } : {}),
      ...(fromId ? { followTokenId: fromId } : {}),
      ...(toId ? { followToTokenId: toId } : {}) };
    if (section.kind === "text") {
      const { at: _anchor, to: _to, repeatCount: _count, repeatDelayMs: _gap, ...projected } = section;
      void _anchor; void _to; void _count; void _gap;
      sections.push({ ...projected, ...coords });
      continue;
    }
    const mime = mimeOf(section.assetId);
    if (!mime || !VISUAL_MIME.has(mime))
      return { ok: false, error: `missing/unsupported visual: ${section.assetId}` };
    const { at: _anchor, to: _to, repeatCount: _count, repeatDelayMs: _gap, ...projected } = section;
    void _anchor; void _to; void _count; void _gap;
    sections.push({ ...projected, ...coords, mime });
  }
  // All authored anchors and media are preflighted before any playback cue is
  // exposed. IDs with '@' cannot collide with an authored section ID (the
  // validator permits only alphanumerics, hyphens and underscores).
  const expanded: ResolvedFxSection[] = [];
  for (const [index, prepared] of sections.entries()) {
    const original = sequence.sections[index];
    if (!original) return { ok: false, error: "FX section lost during preflight" };
    const count = original.repeatCount ?? 1;
    for (let play = 0; play < count; play++) {
      expanded.push(play === 0 ? prepared : { ...prepared, id: `${prepared.id}@${play + 1}`,
        startMs: prepared.startMs + play * (prepared.durationMs + (original.repeatDelayMs ?? 0)) });
    }
  }
  return { ok: true, sections: expanded };
}
