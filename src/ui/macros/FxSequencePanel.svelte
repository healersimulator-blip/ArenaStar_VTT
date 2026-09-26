<script lang="ts">
  import { onDestroy, onMount, untrack } from "svelte";
  import type { ClientSync, ClientEvents } from "../../client/sync";
  import type { EventBus } from "../../core/events";
  import type { ActorDocument, AssetManifest, MacroDocument, SceneDocument } from "../../core/documents";
  import { FX_FILTER_RANGES, FX_MASK_LIMITS, FX_SCALE_LIMITS, FX_SPIN_LIMIT, resolveFxSequence,
    validateFxSequence, type FxAnchor,
    type FxBlendMode, type FxCameraPathSection, type FxEasing, type FxFilterKind, type FxMask,
    type FxSection, type FxSectionAudience, type FxSequence, type FxImportPermissions } from "../../core/fx";
  import { fxFitnessIssues } from "../../core/fxDelivery";
  import { SOUND_CHANNELS, SOUND_CHANNEL_LABELS, SOUND_RADIUS_LIMITS, cueSilentForViewer,
    soundChannelOf } from "../../core/fxSound";
  import { domCanPlay, fxViewPrefs } from "../../core/fxPrefs";
  import { FX_PRESET_LIMITS, fxPresetSections, validateFxPreset,
    type FxPresetDefinition } from "../../core/fxPresets";
  import { FX_ITEM_EVENT_CONTRACT, FX_ITEM_EVENTS, FX_RECOGNITION_MODES, fxBindingEvents,
    validateFxItemBinding,
    type FxItemBinding, type FxItemEvent, type FxRecognition } from "../../core/fxBinding";
  import type { Json } from "../../core/documents";
  import { rememberPlacement, type NamedPlacement, type RequestCrosshairPick } from "./crosshairPicker";
  import type { PreviewFxSequence } from "./fxPreview";

  let {
    client, bus, onImport = null, listAssets = null, onAssetRights = null, pickedAsset = null,
    activeSceneId = null, onPickAnchor = null, onPreview = null, onStopPreview = null,
  }: {
    client: ClientSync;
    bus: EventBus<ClientEvents>;
    /** The scene the canvas is actually showing; picking and preview need it to match. */
    activeSceneId?: string | null;
    onImport?: ((file: File, permissions: FxImportPermissions) => Promise<{ hash: string; mime: string; name: string }>) | null;
    listAssets?: (() => Promise<AssetManifest>) | null;
    onAssetRights?: ((hash: string, permissions: FxImportPermissions) => Promise<void>) | null;
    pickedAsset?: { hash: string } | null;
    /** GM-local canvas picking through the shared crosshair; null hides the controls. */
    onPickAnchor?: RequestCrosshairPick | null;
    /** Renders the unsaved draft on this tab only — no host commit, no instance, no recipient. */
    onPreview?: PreviewFxSequence | null;
    onStopPreview?: (() => void) | null;
  } = $props();

  let macros = $state<MacroDocument[]>([]);
  /** D-310: the world's saved FX presets — the *look*, reusable across drafts. */
  let presets = $state<MacroDocument[]>([]);
  let presetName = $state("");
  /**
   * D-311: the item binding of the saved timeline being edited. It is authored state on the
   * *timeline* (a binding a player discovers only through a cue they may already read), so the
   * editor lives here, next to the timeline it belongs to.
   */
  let actors = $state<ActorDocument[]>([]);
  let bindActorId = $state("");
  let bindItemId = $state("");
  let bindFailureId = $state("");
  let bindRecognition = $state<FxRecognition>("auto");
  let bindEnabled = $state(true);
  /** D-312: which committed moments fire it. `use` alone is the D-311 behaviour. */
  let bindEvents = $state<FxItemEvent[]>(["use"]);
  let scenes = $state<SceneDocument[]>([]);
  let media = $state<Array<{ hash: string; name: string; mime: string;
    visibility: AssetManifest[string]["visibility"]; exportRights: AssetManifest[string]["exportRights"] }>>([]);
  /**
   * SQ-10: placements this author committed through the crosshair, kept so a later
   * section can reuse one by name instead of re-picking the same spot. Wizard-local
   * by design — the sequence keeps plain host-validated points, so a name can never
   * become a field a host has to trust.
   */
  let placements = $state<NamedPlacement[]>([]);
  let rightsHash = $state("");
  let rightsShare = $state(false);
  let rightsExport = $state(false);
  let name = $state("");
  let editing = $state("");
  let sceneId = $state("");
  let sourceId = $state("");
  let targetId = $state("");
  let playerCallable = $state(false);
  // Neither serving bytes to a connected player nor bundling bytes into a
  // world archive follows from possessing a local copy of a premium pack.
  /** The reach a position gets when the author first picks one (the host bounds it 1–1000). */
  const FX_SOUND_DEFAULT_RADIUS = 30;
  let shareWithPlayers = $state(false);
  let includeInWorldFile = $state(false);
  let draft = $state<FxSequence>({ version: 1, audience: "scene", persistent: false, sections: [] });
  let status = $state("");
  let error = $state("");
  let busy = $state(false);
  /** The local preview this panel started, if any (stopped on close/New/replace). */
  let previewRun = $state("");
  const scene = $derived(scenes.find((s) => s._id === sceneId) ?? null);
  const canPlay = domCanPlay();
  /**
   * SQ-13, authoring half: what this save would ship that a viewer cannot get. The
   * registry gaps are checked against the *same* resolution the host performs, so the
   * warning is about the timeline that would really run — and the visibility check
   * only speaks up when the audience is the whole scene, because "the players cannot
   * receive this" is the one sentence a GM needs before wondering why nothing showed.
   */
  const fitnessIssues = $derived.by(() => {
    if (!scene || draft.sections.length === 0) return [] as string[];
    const entries = Object.fromEntries(media.map((asset) => [asset.hash,
      { mime: asset.mime, ...(asset.visibility ? { visibility: asset.visibility } : {}) }]));
    const resolved = resolveFxSequence(draft, scene, undefined, undefined,
      (id) => entries[id]?.mime);
    if (!resolved.ok) return [] as string[]; // the validator already shows the error
    return fxFitnessIssues(resolved.sections, { entries, canPlay,
      ...(draft.audience === "gm" ? { audience: "gm" as const } : { audience: "scene" as const }) });
  });
  /** Picking and preview draw on the app's own canvas, so the wizard must point at the open scene. */
  const onOpenScene = $derived(!!activeSceneId && activeSceneId === sceneId);

  function refresh(): void {
    macros = [...client.store.getAll("macros")].filter((m) => m.kind === "sequence");
    presets = [...client.store.getAll("macros")].filter((m) => m.kind === "fxPreset");
    scenes = [...client.store.getAll("scenes")];
    actors = [...client.store.getAll("actors")];
    if (!actors.some((actor) => actor._id === bindActorId)) {
      bindActorId = actors[0]?._id ?? "";
      bindItemId = "";
    }
    if (!scenes.some((s) => s._id === sceneId)) sceneId = scenes.find((s) => s.active)?._id ?? scenes[0]?._id ?? "";
  }
  function selectRights(hash: string): void {
    rightsHash = hash;
    const entry = media.find((asset) => asset.hash === hash);
    rightsShare = entry?.visibility === "referenced" || entry?.visibility === "world";
    rightsExport = entry?.exportRights === "granted";
  }
  async function saveRights(): Promise<void> {
    if (!rightsHash || !onAssetRights) return;
    error = ""; status = ""; busy = true;
    try {
      await onAssetRights(rightsHash, { shareWithPlayers: rightsShare, includeInWorldFile: rightsExport });
      await refreshAssets();
      status = "Media permissions updated independently of the timeline; test audience and export before sharing";
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally { busy = false; }
  }
  async function refreshAssets(): Promise<void> {
    if (!listAssets) return;
    try {
      media = Object.entries(await listAssets()).filter(([, e]) =>
        /^(image\/(png|jpeg|webp|gif|avif)|video\/(webm|mp4)|audio\/(mpeg|mp3|wav|ogg|webm|mp4|aac))$/.test(e.mime)
      ).map(([hash, e]) => ({ hash, name: e.name, mime: e.mime,
        visibility: e.visibility, exportRights: e.exportRights }));
      selectRights(media.some((asset) => asset.hash === rightsHash) ? rightsHash : media[0]?.hash ?? "");
    } catch (cause) {
      error = `Asset library: ${String(cause)}`;
    }
  }
  function pick(m: MacroDocument): void {
    stopPreview(); // the cue on the canvas must belong to the draft being edited
    editing = m._id;
    name = m.name;
    playerCallable = m.flags.core?.playerCallable === true;
    loadBinding(m);
    draft = { ...$state.snapshot(m.sequence ?? { version: 1, sections: [] }),
      persistent: m.sequence?.persistent === true };
    status = "Editing saved timeline";
    error = "";
  }
  function reset(): void {
    stopPreview(); // a new draft must not leave the old one's cue on the canvas
    editing = "";
    name = "";
    playerCallable = false;
    loadBinding(null);
    draft = { version: 1, audience: "scene", persistent: false, sections: [] };
    status = "";
    error = "";
  }
  /** A camera cue's default: a short eased pan to the middle of the scene. */
  function cameraSection(id: string, startMs: number, durationMs = 1500): FxSection {
    return { id, kind: "camera", mode: "pan", startMs, durationMs,
      to: { kind: "point", x: Math.round((scene?.width ?? 500) / 2), y: Math.round((scene?.height ?? 500) / 2) },
      easing: "easeInOut" };
  }
  function add(kind: FxSection["kind"]): void {
    const id = `fx-${globalThis.crypto.randomUUID().slice(0, 8)}`;
    const startMs = Math.min(30_000, Math.max(0, ...draft.sections.map((s) =>
      s.startMs + s.durationMs * (s.repeatCount ?? 1) +
      ((s.repeatCount ?? 1) - 1) * (s.repeatDelayMs ?? 0) - 250)));
    const durationMs = kind === "wait" ? 500 : 1000;
    const at = { kind: "point" as const, x: Math.round((scene?.width ?? 500) / 2), y: Math.round((scene?.height ?? 500) / 2) };
    const section: FxSection = kind === "text" ? { id, kind, startMs, durationMs, at, text: "A dramatic moment" }
      : kind === "image" ? { id, kind, startMs, durationMs, at, assetId: media.find((m) => /^(image|video)\//.test(m.mime))?.hash ?? "" }
      : kind === "sound" ? { id, kind, startMs, durationMs, assetId: media.find((m) => m.mime.startsWith("audio/"))?.hash ?? "", volume: 0.8, channel: "sfx" as const }
      : kind === "camera" ? cameraSection(id, startMs)
      : { id, kind, startMs, durationMs };
    draft = { ...draft, sections: [...draft.sections, section] };
  }
  function applyPickedAsset(hash: string): void {
    const entry = client.store.world.assetManifest[hash];
    if (!entry) { error = "Selected media is no longer in this world"; return; }
    const kind = entry.mime.startsWith("audio/") ? "sound" : "image";
    const index = draft.sections.findLastIndex((section) => section.kind === kind);
    if (index < 0) add(kind);
    const selected = index < 0 ? draft.sections.length - 1 : index;
    draft = { ...draft, sections: draft.sections.map((section, i) => i === selected &&
      (section.kind === "image" || section.kind === "sound")
      ? { ...section, assetId: hash } : section) };
    status = `${entry.name} selected for the ${kind} section; save the timeline to publish`;
  }
  // The browser's "Use in timeline" action is a new object for each click.
  // Untrack the editor draft so subsequent typing never re-applies the choice.
  $effect(() => { const choice = pickedAsset; if (choice) untrack(() => applyPickedAsset(choice.hash)); });

  function changeKind(index: number, kind: FxSection["kind"]): void {
    const before = draft.sections[index];
    if (!before) return;
    const at = { kind: "point" as const, x: Math.round((scene?.width ?? 500) / 2), y: Math.round((scene?.height ?? 500) / 2) };
    const section: FxSection = kind === "image" ? { id: before.id, kind, at, assetId: "", startMs: before.startMs, durationMs: before.durationMs }
      : kind === "sound" ? { id: before.id, kind, assetId: "", startMs: before.startMs, durationMs: before.durationMs, volume: 0.8, channel: soundChannelOf(before) }
      : kind === "text" ? { id: before.id, kind, at, text: "A dramatic moment", startMs: before.startMs, durationMs: before.durationMs }
      : kind === "camera" ? cameraSection(before.id, before.startMs, Math.max(100, before.durationMs))
      : { id: before.id, kind, startMs: before.startMs, durationMs: before.durationMs };
    draft = { ...draft, sections: draft.sections.map((old, i) => i === index ? section : old) };
  }
  /** Pan ⇄ shake ⇄ path is a real discriminator: the shapes share no destination field. */
  function changeCameraMode(index: number, mode: "pan" | "shake" | "path"): void {
    const before = draft.sections[index];
    if (!before || before.kind !== "camera") return;
    const section: FxSection = mode === "shake"
      ? { id: before.id, kind: "camera", mode: "shake", intensity: 0.4, startMs: before.startMs,
          durationMs: Math.min(before.durationMs, 800) }
      : mode === "path" ? pathSection(before.id, before.startMs, Math.max(1_000, before.durationMs))
      : cameraSection(before.id, before.startMs);
    draft = { ...draft, sections: draft.sections.map((old, i) => i === index ? section : old) };
  }
  /**
   * Waypoint editing. A path is a *tour*: at least two points that differ, and the
   * first leg runs from wherever each viewer already is (the host resolves the rest).
   * The defaults are spread across the scene so a fresh path visibly goes somewhere.
   */
  function pathSection(id: string, startMs: number, durationMs = 2000): FxSection {
    const width = scene?.width ?? 500;
    const height = scene?.height ?? 500;
    return { id, kind: "camera", mode: "path", startMs, durationMs, easing: "easeInOut",
      points: [{ kind: "point", x: Math.round(width * 0.25), y: Math.round(height * 0.3) },
        { kind: "point", x: Math.round(width * 0.75), y: Math.round(height * 0.7) }] };
  }
  function changeWaypoint(index: number, way: number, patch: Partial<FxCameraPathSection["points"][number]>): void {
    const before = draft.sections[index];
    if (!before || before.kind !== "camera" || before.mode !== "path") return;
    const points = before.points.map((point, i) => i === way ? { ...point, ...patch } as FxAnchor : point);
    draft = { ...draft, sections: draft.sections.map((old, i) => i === index
      ? { ...before, points } as FxSection : old) };
  }
  function changeWaypointKind(index: number, way: number, kind: "point" | "source" | "target"): void {
    const before = draft.sections[index];
    if (!before || before.kind !== "camera" || before.mode !== "path") return;
    const at = { kind, x: Math.round((scene?.width ?? 500) / 2), y: Math.round((scene?.height ?? 500) / 2) };
    changeWaypoint(index, way, kind === "point" ? { kind, x: at.x, y: at.y } : { kind } as never);
  }
  function addWaypoint(index: number): void {
    const before = draft.sections[index];
    if (!before || before.kind !== "camera" || before.mode !== "path" || before.points.length >= 8) return;
    const last = before.points[before.points.length - 1];
    // A new waypoint starts mirrored across the scene's centre, so a fresh tour visibly
    // goes somewhere instead of stacking three anchors on one spot.
    const x = last?.kind === "point" ? Math.round(scene?.width ?? 500) - last.x : Math.round((scene?.width ?? 500) / 2);
    const y = last?.kind === "point" ? Math.round(scene?.height ?? 500) - last.y : Math.round((scene?.height ?? 500) / 2);
    const points = [...before.points, { kind: "point" as const, x, y }];
    draft = { ...draft, sections: draft.sections.map((old, i) => i === index
      ? { ...before, points } as FxSection : old) };
  }
  function removeWaypoint(index: number, way: number): void {
    const before = draft.sections[index];
    if (!before || before.kind !== "camera" || before.mode !== "path" || before.points.length <= 2) return;
    const points = before.points.filter((_point, i) => i !== way);
    draft = { ...draft, sections: draft.sections.map((old, i) => i === index
      ? { ...before, points } as FxSection : old) };
  }
  function changeCameraDestination(index: number, kind: "point" | "source" | "target"): void {
    const before = draft.sections[index];
    if (!before || before.kind !== "camera" || before.mode !== "pan") return;
    const to = kind === "point"
      ? { kind, x: Math.round((scene?.width ?? 500) / 2), y: Math.round((scene?.height ?? 500) / 2) }
      : { kind };
    draft = { ...draft, sections: draft.sections.map((old, i) => i === index
      ? { ...before, to } as FxSection : old) };
  }
  function changeCameraZoom(index: number, value: string): void {
    const before = draft.sections[index];
    if (!before || before.kind !== "camera" || before.mode === "shake") return;
    const zoom = value.trim() === "" ? undefined : Number(value);
    draft = { ...draft, sections: draft.sections.map((old, i) => i === index
      ? { ...before, ...(zoom === undefined ? {} : { zoom }) } as FxSection : old) };
  }

  /**
   * Blend and filter are optional fields whose absence is meaningful (`normal`, no
   * filter), so "Normal"/"None" delete the field rather than storing a no-op value the
   * host would then have to treat as authored.
   */
  function changeBlend(index: number, value: string): void {
    const before = draft.sections[index];
    if (!before || (before.kind !== "image" && before.kind !== "text")) return;
    // Cleared means *absent*: a key left holding `undefined` is not the same document
    // once it crosses a payload boundary, where it becomes something the host refuses.
    const { blend: _blend, ...remaining } = before;
    void _blend;
    draft = { ...draft, sections: draft.sections.map((old, i) => i === index
      ? (value === "normal" ? remaining : { ...remaining, blend: value as FxBlendMode }) as FxSection : old) };
  }

  /**
   * Switching the kind resets the strength to that kind's default *and* drops any
   * animation: 16 is a heavy blur and an impossible grayscale, so carrying the number
   * over would either be refused by the host or silently mean something else (the D-301
   * rule for a mask's shape fields, applied to a filter's own).
   */
  function changeFilter(index: number, value: string): void {
    const before = draft.sections[index];
    if (!before || (before.kind !== "image" && before.kind !== "text")) return;
    const { filter: _filter, filterTo: _filterTo, ...remaining } = before;
    void _filter; void _filterTo;
    const kind = value as FxFilterKind;
    draft = { ...draft, sections: draft.sections.map((old, i) => i === index
      ? (value === "none" ? remaining
        : { ...remaining, filter: { kind, strength: FX_FILTER_RANGES[kind].default } }) as FxSection : old) };
  }

  function changeFilterStrength(index: number, value: string): void {
    const before = draft.sections[index];
    if (!before || (before.kind !== "image" && before.kind !== "text") || !before.filter) return;
    const { kind } = before.filter;
    const range = FX_FILTER_RANGES[kind];
    const strength = Number(value);
    draft = { ...draft, sections: draft.sections.map((old, i) => i === index
      ? { ...before, filter: { kind, strength: Number.isFinite(strength)
          ? Math.min(range.max, Math.max(range.min, strength)) : range.default } } as FxSection
      : old) };
  }

  /**
   * One sentence under the filter controls, because "applied once" stops being true the
   * moment the second box is filled — and a hint that lies is worse than no hint.
   */
  function filterHint(section: Extract<FxSection, { kind: "image" | "text" }>): string {
    const filter = section.filter;
    if (!filter) return "";
    const range = FX_FILTER_RANGES[filter.kind];
    const start = filter.strength ?? range.default;
    if (section.filterTo === undefined || section.filterTo === start)
      return `One filter per section: ${range.min}–${range.max}${range.unit}, applied once. Fill "move to" to carry it to another strength across the section.`;
    const cycles = section.repeats ?? 1;
    return `Moves from ${start}${range.unit} to ${section.filterTo}${range.unit}, ${cycles === 1
      ? "eased across the section." : `restarted in each of its ${cycles} cycles — a pulse.`}`;
  }

  /**
   * Where the filter ends, if the author wants it to move at all. Same rule as every
   * other animation field here: empty means no key, clamped to the kind's own range so
   * the host never receives a value it would refuse.
   */
  function changeFilterTo(index: number, value: string): void {
    const before = draft.sections[index];
    if (!before || (before.kind !== "image" && before.kind !== "text") || !before.filter) return;
    const range = FX_FILTER_RANGES[before.filter.kind];
    const { filterTo: _filterTo, ...remaining } = before;
    void _filterTo;
    const trimmed = value.trim();
    const filterTo = trimmed === "" ? undefined : Number(trimmed);
    draft = { ...draft, sections: draft.sections.map((old, i) => i === index
      ? ({ ...remaining, ...(filterTo === undefined || !Number.isFinite(filterTo) ? {} : {
          filterTo: Math.min(range.max, Math.max(range.min, filterTo)) }) } as FxSection) : old) };
  }

  /**
   * Who a camera cue moves. `scene` is the default and is stored by *omitting* the
   * field, like every other "no setting" in this panel — the host then treats the cue
   * as everyone, and a reader cannot mistake a stored `scene` for an author's choice.
   */
  function changeCameraAudience(index: number, value: string): void {
    const before = draft.sections[index];
    if (!before || before.kind !== "camera") return;
    const { audience: _audience, ...remaining } = before;
    void _audience;
    draft = { ...draft, sections: draft.sections.map((old, i) => i === index
      ? (value === "scene" ? remaining : { ...remaining, audience: value as FxSectionAudience }) as FxSection
      : old) };
  }

  /**
   * A mask is rebuilt from scratch when its shape changes: a circle that kept a ray's
   * width would be a field the host refuses, so switching kinds drops what the new
   * kind has no use for. "None" removes the key entirely (the msgpack lesson).
   */
  /**
   * An empty field means "no animation" and removes the key, rather than storing a
   * number that happens to equal the start (the host would then treat it as authored).
   */
  function changeScaleTo(index: number, value: string): void {
    const before = draft.sections[index];
    if (!before || (before.kind !== "image" && before.kind !== "text")) return;
    const { scaleTo: _scaleTo, ...remaining } = before;
    void _scaleTo;
    const trimmed = value.trim();
    const scaleTo = trimmed === "" ? undefined : Number(trimmed);
    draft = { ...draft, sections: draft.sections.map((old, i) => i === index
      ? ({ ...remaining, ...(scaleTo === undefined || !Number.isFinite(scaleTo) ? {} : {
          scaleTo: Math.min(FX_SCALE_LIMITS.max, Math.max(FX_SCALE_LIMITS.min, scaleTo)) }) } as FxSection) : old) };
  }

  function changeSpin(index: number, value: string): void {
    const before = draft.sections[index];
    if (!before || (before.kind !== "image" && before.kind !== "text")) return;
    const { spinDeg: _spin, ...remaining } = before;
    void _spin;
    const trimmed = value.trim();
    const spin = trimmed === "" ? undefined : Number(trimmed);
    draft = { ...draft, sections: draft.sections.map((old, i) => i === index
      ? ({ ...remaining, ...(spin === undefined || !Number.isFinite(spin) ? {} : {
          spinDeg: Math.min(FX_SPIN_LIMIT, Math.max(-FX_SPIN_LIMIT, spin)) }) } as FxSection) : old) };
  }

  /**
   * SQ-05/D-307: stop the region where a wall blocks sight. The host bakes the trim against
   * its own walls, so a region bounded this way **cannot animate** — turning the bound on
   * therefore clears any growth or turn the author had already entered, and the animation
   * fields stay away while it is on (a control that silently does nothing is the thing
   * SQ-05 forbids).
   */
  function changeMaskWalls(index: number, on: boolean): void {
    const before = draft.sections[index];
    if (!before || (before.kind !== "image" && before.kind !== "text") || !before.mask) return;
    const { walls: _walls, lengthTo: _lengthTo, spinDeg: _spinDeg, ...rest } = before.mask;
    void _walls; void _lengthTo; void _spinDeg;
    const mask: FxMask = on ? { ...rest, walls: true } : rest;
    draft = { ...draft, sections: draft.sections.map((old, i) => i === index
      ? { ...before, mask } as FxSection : old) };
    status = on && (before.mask.lengthTo !== undefined || before.mask.spinDeg !== undefined)
      ? "Wall-bounded: the region is trimmed against the scene's walls, which a recipient never receives — so its growth/turn was cleared."
      : on ? "Wall-bounded: the region is trimmed against the scene's walls when the timeline is saved."
        : "";
  }

  function changeMask(index: number, value: string): void {
    const before = draft.sections[index];
    if (!before || (before.kind !== "image" && before.kind !== "text")) return;
    const { mask: _mask, ...remaining } = before;
    void _mask;
    const keepInvert = before.mask?.invert === true ? { invert: true } : {};
    const shapeless = value === "none";
    const kind = value as FxMask["kind"];
    const mask: FxMask | null = shapeless ? null
      : kind === "circle" ? { kind, length: 15, ...keepInvert }
        : kind === "cone" ? { kind, length: 30, spread: 53.13, angle: 0, ...keepInvert }
          : { kind, length: 30, width: 5, angle: 0, ...keepInvert };
    draft = { ...draft, sections: draft.sections.map((old, i) => i === index
      ? (mask ? { ...remaining, mask } : remaining) as FxSection : old) };
  }

  function changeMaskField(index: number, patch: Partial<FxMask>): void {
    const before = draft.sections[index];
    if (!before || (before.kind !== "image" && before.kind !== "text") || !before.mask) return;
    const mask = { ...before.mask, ...patch };
    draft = { ...draft, sections: draft.sections.map((old, i) => i === index
      ? { ...before, mask } as FxSection : old) };
  }

  /**
   * The mask's own animation (D-305). An emptied box removes the key rather than storing a
   * number, and the value is clamped to the same bounds the host checks — a region's
   * geometry is measured in scene units, so its growth is too.
   */
  function changeMaskAnimation(index: number, field: "lengthTo" | "spinDeg", value: string): void {
    const before = draft.sections[index];
    if (!before || (before.kind !== "image" && before.kind !== "text") || !before.mask) return;
    const { [field]: _dropped, ...rest } = before.mask;
    void _dropped;
    const trimmed = value.trim();
    const parsed = trimmed === "" ? undefined : Number(trimmed);
    const bounds: [number, number] = field === "lengthTo"
      ? [FX_MASK_LIMITS.min, FX_MASK_LIMITS.max] : [-FX_SPIN_LIMIT, FX_SPIN_LIMIT];
    const mask: FxMask = parsed === undefined || !Number.isFinite(parsed) ? rest
      : { ...rest, [field]: Math.min(bounds[1], Math.max(bounds[0], parsed)) };
    draft = { ...draft, sections: draft.sections.map((old, i) => i === index
      ? { ...before, mask } as FxSection : old) };
  }

  function changeReplayCount(index: number, value: string): void {
    const section = draft.sections[index];
    if (!section || section.kind === "wait") return;
    const count = Number(value);
    if (count === 1) {
      const single = { ...section };
      Reflect.deleteProperty(single, "repeatCount");
      Reflect.deleteProperty(single, "repeatDelayMs");
      draft.sections[index] = single;
    } else draft.sections[index] = { ...section, repeatCount: count };
  }
  function changeReplayGap(index: number, value: string): void {
    const section = draft.sections[index];
    if (!section || section.kind === "wait") return;
    draft.sections[index] = { ...section, repeatDelayMs: Number(value) };
  }
  function changeAnchor(index: number, kind: "point" | "source" | "target"): void {
    const before = draft.sections[index];
    if (!before || (before.kind !== "image" && before.kind !== "text")) return;
    // Replace the entire discriminated anchor; retaining point x/y on a token anchor is rejected by the host.
    const at = kind === "point"
      ? { kind, x: Math.round((scene?.width ?? 500) / 2), y: Math.round((scene?.height ?? 500) / 2) }
      : { kind };
    draft = { ...draft, sections: draft.sections.map((old, i) => i === index
      ? { ...before, at, follow: kind === "point" && (!before.to || before.to.kind === "point")
          ? false : before.follow } as FxSection : old) };
  }
  function changeDestination(index: number, kind: "none" | "point" | "source" | "target"): void {
    const before = draft.sections[index];
    if (!before || (before.kind !== "image" && before.kind !== "text")) return;
    const { to: _to, repeats: _repeats, ...remaining } = before;
    void _to; void _repeats;
    const to = kind === "point" ? { kind, x: Math.round((scene?.width ?? 500) / 2),
      y: Math.round((scene?.height ?? 500) / 2) } : kind === "none" ? null : { kind };
    draft = { ...draft, sections: draft.sections.map((old, i) => i === index
      ? { ...remaining, ...(to ? { to } : {}),
          follow: (kind === "none" || kind === "point") && before.at.kind === "point" ? false : before.follow,
          ...(kind === "none" && before.kind === "image" ? { stretch: false } : {}) } as FxSection : old) };
  }
  function remove(index: number): void {
    draft = { ...draft, sections: draft.sections.filter((_, i) => i !== index) };
  }
  // ─── D-310 (SQ-12): save/load/edit/delete the look ──────────────────────────
  //
  // A preset is the draft's **sections**: the look, not the run. Persistence, audience
  // and the bound source/target tokens are the timeline's own and are left alone by a
  // load, so dropping a "fireball look" into a looping aura keeps it a loop. Loading
  // edits the draft and nothing else — the host still validates the timeline on save,
  // and nothing reaches the table until it is saved and run.
  /** A snapshot, never a live reference: a preset must not alias editable draft state. */
  function draftSections(): FxSection[] {
    return $state.snapshot(draft).sections;
  }
  function submitPreset(preset: FxPresetDefinition, macro: MacroDocument | null, nextName: string): boolean {
    if (macro) {
      client.submit([{ kind: "update", ref: { coll: "macros", id: macro._id },
        diff: { preset: preset as unknown as Json } }]);
      status = `Updating preset "${macro.name}" from the draft`;
      return true;
    }
    const doc: MacroDocument = { _id: globalThis.crypto.randomUUID(), type: "macro", name: nextName,
      command: "", kind: "fxPreset", ownership: { default: 0 }, flags: {}, system: {}, preset };
    client.submit([{ kind: "create", coll: "macros", data: doc }]);
    status = `Preset "${nextName}" submitted with ${preset.sections.length} section(s) — load it into any draft`;
    return true;
  }
  function savePreset(): void {
    error = ""; status = "";
    const nextName = presetName.trim();
    if (!nextName) { error = "Name the preset before saving it"; return; }
    if (nextName.length > FX_PRESET_LIMITS.name) {
      error = `Preset names are at most ${FX_PRESET_LIMITS.name} characters`; return;
    }
    if (draft.sections.length === 0) { error = "A preset bundles sections — add one to the draft first"; return; }
    const checked = validateFxPreset({ version: 1, sections: draftSections() });
    if (!checked.ok) { error = checked.error; return; }
    submitPreset(checked.preset, null, nextName);
  }
  function updatePreset(macro: MacroDocument): void {
    error = ""; status = "";
    if (draft.sections.length === 0) { error = "A preset bundles sections — add one to the draft first"; return; }
    const checked = validateFxPreset({ version: 1, sections: draftSections() });
    if (!checked.ok) { error = checked.error; return; }
    submitPreset(checked.preset, macro, macro.name);
  }
  function loadPreset(macro: MacroDocument): void {
    error = "";
    const checked = validateFxPreset(macro.preset);
    if (!checked.ok) { error = `Preset "${macro.name}" cannot be loaded: ${checked.error}`; return; }
    stopPreview(); // the cue on the canvas belongs to the draft that is about to be replaced
    // Fresh ids per section, because the same preset may be loaded twice into one
    // timeline and a repeated id is a document the host refuses.
    const sections = fxPresetSections(checked.preset, () => `fx-${globalThis.crypto.randomUUID().slice(0, 8)}`);
    draft = { ...draft, sections };
    presetName = macro.name;
    status = `Loaded preset "${macro.name}" — ${sections.length} section(s) replaced the draft`
      + (editing ? "; save the timeline to publish the change" : "; save the timeline to publish it");
  }
  function renamePreset(macro: MacroDocument, value: string): void {
    const next = value.trim();
    if (next === macro.name) return;
    error = ""; status = "";
    if (!next) { error = "A preset needs a name"; return; }
    if (next.length > FX_PRESET_LIMITS.name) {
      error = `Preset names are at most ${FX_PRESET_LIMITS.name} characters`; return;
    }
    client.submit([{ kind: "update", ref: { coll: "macros", id: macro._id }, diff: { name: next } }]);
    status = `Renaming preset to "${next}"`;
  }
  function deletePreset(macro: MacroDocument): void {
    error = ""; status = "";
    client.submit([{ kind: "delete", ref: { coll: "macros", id: macro._id } }]);
    status = `Deleting preset "${macro.name}"`;
  }

  // ─── D-311 (SQ-12's last clause): bind this timeline to an item ─────────────
  //
  // The binding is stored on the timeline rather than on the item, so the ordinary macro
  // projection decides who can discover it — and an id never travels to a reader who could
  // not already read the timeline. The *editor* is therefore the timeline's author, and the
  // use path (the item's own cast) is a plain host-checked cue request.
  const boundItems = $derived(actors.find((actor) => actor._id === bindActorId)?.items ?? []);
  /** Every *other* saved timeline, for the failure branch. */
  const otherTimelines = $derived(macros.filter((macro) => macro._id !== editing));
  const bindItemName = $derived(boundItems.find((item) => item._id === bindItemId)?.name ?? "");

  function loadBinding(macro: MacroDocument | null): void {
    const binding = macro?.fxItem;
    bindActorId = binding?.actorId ?? actors[0]?._id ?? "";
    bindItemId = binding?.itemId ?? "";
    bindFailureId = binding?.onFailureId ?? "";
    bindRecognition = binding?.recognition ?? "auto";
    bindEnabled = binding?.enabled !== false;
    bindEvents = binding === undefined ? ["use"] : [...fxBindingEvents(binding)];
  }
  /** The checkbox helper: at least one event stays ticked, so the author cannot save "never". */
  function toggleBindEvent(event: FxItemEvent, on: boolean): void {
    const next = on ? [...new Set([...bindEvents, event])] : bindEvents.filter((e) => e !== event);
    bindEvents = next.length > 0 ? next : bindEvents;
  }
  /** The contract sentence the wizard shows for the moments this binding fires on. */
  const bindEventHelp = $derived(bindEvents
    .map((event) => `${FX_ITEM_EVENT_CONTRACT[event].label} — ${FX_ITEM_EVENT_CONTRACT[event].failure}`)
    .join("; "));
  function selectBindActor(id: string): void {
    bindActorId = id;
    bindItemId = "";
  }
  /** The authored shape, or the reason it cannot be stored — the host repeats this check. */
  function bindingDraft(): FxItemBinding {
    const events = FX_ITEM_EVENTS.filter((event) => bindEvents.includes(event));
    return { actorId: bindActorId, itemId: bindItemId,
      ...(bindFailureId ? { onFailureId: bindFailureId } : {}),
      ...(bindRecognition !== "auto" ? { recognition: bindRecognition } : {}),
      ...(bindEnabled ? {} : { enabled: false }),
      // The default is written out only when it is not the default: a binding saved from the
      // wizard carries the events the author actually ticked.
      ...(events.length === 1 && events[0] === "use" ? {} : { events }) };
  }
  function saveBinding(): void {
    error = ""; status = "";
    if (!editing) { error = "Save the timeline before binding it to an item"; return; }
    const checked = validateFxItemBinding(bindingDraft());
    if (!checked.ok) { error = checked.error; return; }
    client.submit([{ kind: "update", ref: { coll: "macros", id: editing },
      diff: { fxItem: checked.binding as unknown as Json } }]);
    status = `Binding submitted — "${name.trim() || "this timeline"}" will play when `
      + `${bindItemName || "the item"} is used`
      + (playerCallable ? "" : ". Tick \"players may run this\" or a player's use will be refused");
  }
  function removeBinding(): void {
    error = ""; status = "";
    if (!editing) return;
    // Cleared means *deleted* (the D-295 msgpack trap: `undefined` arrives as `null`).
    client.submit([{ kind: "update", ref: { coll: "macros", id: editing }, diff: { "-=fxItem": null } }]);
    bindItemId = ""; bindFailureId = ""; bindRecognition = "auto"; bindEnabled = true;
    bindEvents = ["use"];
    status = "Binding removed — the item plays nothing";
  }

  function save(): void {
    error = "";
    status = "";
    if (!name.trim()) { error = "Enter a timeline name"; return; }
    const checked = validateFxSequence(draft);
    if (!checked.ok) { error = checked.error; return; }
    if (editing) {
      const existing = macros.find((m) => m._id === editing);
      if (!existing) { error = "Saved macro was deleted"; return; }
      client.submit([{ kind: "update", ref: { coll: "macros", id: editing }, diff: {
        name: name.trim(), sequence: $state.snapshot(draft) as unknown as Json,
        flags: { ...existing.flags, core: { ...existing.flags.core, playerCallable } },
      } }]);
      status = "Timeline update submitted";
    } else {
      const doc: MacroDocument = { _id: globalThis.crypto.randomUUID(), type: "macro", name: name.trim(),
        ownership: { default: 1 }, flags: { core: { playerCallable } }, system: {},
        kind: "sequence", command: "", sequence: $state.snapshot(draft) };
      client.submit([{ kind: "create", coll: "macros", data: doc }]);
      editing = doc._id;
      loadBinding(doc); // a new timeline starts with no binding, never the previous one's
      status = "Timeline submitted; use Run once it appears in the list";
    }
  }
  function run(macroId: string): void {
    if (!sceneId) { error = "Choose a scene"; return; }
    client.requestSequence(macroId, sceneId, sourceId || undefined, targetId || undefined);
    // D-297: the author is the first viewer. If this device's own mix silences the
    // whole timeline, say so here rather than letting them wonder why the table is
    // reacting to something they cannot hear. The request itself is unchanged.
    const sections = (macros.find((macro) => macro._id === macroId)?.sequence?.sections) ?? [];
    status = cueSilentForViewer(sections, fxViewPrefs().soundMix)
      ? "Requested saved timeline from host — this device's own mix silences every sound in it, so you will not hear this run"
      : "Requested saved timeline from host";
  }
  /**
   * Canvas picking for a point anchor. Cancel resolves `null`, so an abandoned
   * gesture cannot half-edit the draft; square/hex snap to the cell or hex centre,
   * gridless stays exact, and the overlay refuses a point the host would refuse.
   */
  /**
   * SQ-12's other placement mode: one gesture fills both ends of a section — the start
   * where the effect begins and the destination it travels to — instead of two picks.
   * The drag's direction is the section's bearing for free (a stretched image lies along
   * it, a cone points down it), and its length becomes the visual's own tween distance.
   * Only a located section can carry a destination at all, so only those offer it.
   */
  async function dragSection(index: number): Promise<void> {
    const before = draft.sections[index];
    if (!before || (before.kind !== "image" && before.kind !== "text") || !onPickAnchor || !scene) return;
    error = ""; status = "";
    const placement = await onPickAnchor({ sceneId: scene._id, gesture: "drag",
      label: "from the start to the destination", shapes: ["point", "ray", "rect"], named: placements,
      hint: "The host validates the saved sequence — this only writes the draft." });
    if (!placement?.source) { status = "Drag cancelled — the draft is unchanged"; return; }
    placements = rememberPlacement(placements, placement);
    const from = { x: Math.round(placement.source.x), y: Math.round(placement.source.y) };
    const to = { x: Math.round(placement.point.x), y: Math.round(placement.point.y) };
    draft = { ...draft, sections: draft.sections.map((old, i) => i === index
      // Both ends are plain points now, so a token follow cannot survive: the host
      // resolves `follow` only against bound anchors, and this placement binds nobody.
      ? { ...old, at: { kind: "point" as const, ...from }, to: { kind: "point" as const, ...to },
          follow: false } as FxSection : old) };
    const length = placement.lineLength !== undefined ? ` over ${placement.lineLength.toFixed(1)} ${scene.grid.units ?? "units"}` : "";
    status = `"${placement.name}": ${from.x}, ${from.y} → ${to.x}, ${to.y}${length} at ${placement.angleDeg}° — save the timeline to publish it`;
  }

  async function pickPoint(index: number, which: "at" | "to" | "camera" | "waypoint" | "sound", way = 0): Promise<void> {
    const before = draft.sections[index];
    const cameraPan = before?.kind === "camera" && before.mode === "pan";
    const waypoint = before?.kind === "camera" && before.mode === "path"
      ? before.points[way] : undefined;
    const located = before?.kind === "image" || before?.kind === "text";
    const sound = before?.kind === "sound";
    if (!before || (which === "waypoint" ? !waypoint : which === "camera" ? !cameraPan
        : which === "sound" ? !sound : !located) || !onPickAnchor || !scene) return;
    error = ""; status = "";
    // Shapes and constraints come from the draft: a stretched image, a camera pan or a
    // path leg is a *direction*, so a ray/rect is the honest instrument, and a plain
    // anchor stays a point. Nothing here is a host rule the sequence would not check.
    const stretch = before.kind === "image" && before.stretch === true;
    // A sound is *at* a place and has no area, so it is the one pick that is a plain
    // point: offering a cone would be offering a shape the host would refuse.
    const shapes = which === "sound" ? ["point"] as const
      : which === "to" || which === "camera" || which === "waypoint" || stretch
        ? ["point", "ray", "rect"] as const : ["point", "circle", "cone", "rect"] as const;
    const placement = await onPickAnchor({ sceneId: scene._id,
      label: which === "sound" ? "where the sound comes from"
        : which === "at" ? "the section's start point"
        : which === "camera" ? "where the camera should look"
        : which === "waypoint" ? `waypoint ${way + 1}` : "the destination point",
      shapes, named: placements,
      hint: "The host validates the saved sequence — this only writes the draft." });
    if (!placement) { status = "Pick cancelled — the draft is unchanged"; return; }
    placements = rememberPlacement(placements, placement);
    const point = { x: Math.round(placement.point.x), y: Math.round(placement.point.y) };
    if (which === "waypoint") {
      changeWaypoint(index, way, { kind: "point", x: point.x, y: point.y } as never);
      status = `Waypoint ${way + 1} set to ${point.x}, ${point.y} — save the timeline to publish it`;
      return;
    }
    draft = { ...draft, sections: draft.sections.map((old, i) => {
      if (i !== index) return old;
      // A sound's position comes with its radius, filled to the panel's own default the
      // first time: the host refuses a position with no reach, and an author who picked a
      // spot has already said "this one is positional".
      if (old.kind === "sound")
        return { ...old, at: { kind: "point" as const, ...point },
          radius: old.radius ?? FX_SOUND_DEFAULT_RADIUS } as FxSection;
      if (old.kind === "camera" && old.mode === "pan")
        return { ...old, to: { kind: "point" as const, ...point } } as FxSection;
      if (old.kind !== "image" && old.kind !== "text") return old;
      if (which === "to") return { ...old, to: { kind: "point" as const, ...point } } as FxSection;
      // Replacing the start with a point can invalidate a token follow: keep it only
      // while the destination is still a bound token, which is the host's own rule.
      const keepsFollow = old.follow === true &&
        old.to !== undefined && (old.to.kind === "source" || old.to.kind === "target");
      return { ...old, at: { kind: "point" as const, ...point }, follow: keepsFollow } as FxSection;
    }) };
    const extent = placement.shape.kind === "point" ? "" : ` (${placement.shape.kind} area measured, not committed)`;
    status = `Anchor "${placement.name}" set to ${point.x}, ${point.y}${extent} — save the timeline to publish it`;
  }
  /**
   * Preview the **unsaved draft** on this canvas: same validation as a save, but
   * the host is never asked, so no world op, no durable instance and no player
   * sees it. A persistent draft previews one pass; an unopened scene cannot be
   * previewed at all rather than silently rendering the wrong map.
   */
  async function preview(): Promise<void> {
    error = ""; status = "";
    if (!onPreview) return;
    const checked = validateFxSequence(draft);
    if (!checked.ok) { error = checked.error; return; }
    if (!scene || !onOpenScene) { error = "Open this timeline's scene to preview it on the canvas"; return; }
    const result = await onPreview($state.snapshot(draft), sceneId, sourceId, targetId);
    if (!result.ok) { error = result.error; return; }
    previewRun = result.runId;
    status = draft.persistent
      ? "Previewing one local pass — save and Run to create the durable instance"
      : "Previewing locally on this canvas; nothing is saved, committed or sent to players";
  }
  function stopPreview(): void {
    if (!previewRun) return;
    onStopPreview?.();
    previewRun = "";
    status = "Preview stopped";
  }
  async function importFile(event: Event): Promise<void> {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file || !onImport) return;
    error = "";
    busy = true;
    try {
      if (file.size > 200 * 1024 * 1024) throw new Error("Media file exceeds 200 MiB");
      const item = await onImport(file, { shareWithPlayers, includeInWorldFile });
      await refreshAssets();
      selectRights(item.hash);
      status = `Imported ${item.name} (${item.mime}) — ${shareWithPlayers ? "eligible scene viewers may fetch it" : "GM-only playback"}; ${includeInWorldFile ? "world export enabled" : "world ZIP export blocked until rights are confirmed"}`;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      busy = false;
      input.value = "";
    }
  }

  onMount(() => {
    const offSnapshot = bus.on("snapshot", refresh);
    const offOps = bus.on("ops", refresh);
    const offRejected = bus.on("rejected", (reason) => { error = `${reason.reason}: ${reason.detail}`; });
    refresh();
    void refreshAssets();
    return () => { offSnapshot(); offOps(); offRejected(); };
  });
  // Closing the wizard (or leaving the world) ends this tab's own preview; the
  // windows are not part of the world, so nothing else would clear it.
  onDestroy(() => { if (previewRun) onStopPreview?.(); });
</script>

<section class="fx-wizard" aria-label="FX sequence wizard" data-fx-wizard>
  <header><h3>FX timeline wizard</h3><button type="button" onclick={reset}>New</button></header>
  <p class="hint">Author overlapping image/video/text/audio sections. One-shot sections can replay at a fixed interval; host-approved cues stay beneath fog. Persistent timelines loop until stopped in Live FX or their source disappears (they cannot also use section replays). A **Camera** section pans or shakes the *viewer's own* view — the host resolves where a pan may land, and a real drag or zoom always takes the map back. <strong>Preview</strong> renders the unsaved draft on this tab's canvas only — no host commit, no durable instance, no player receives it; a persistent draft previews a single pass. This is a subset of the full Sequencer action library.</p>
  <div class="library">
    <label>Import licensed media <input type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/avif,video/webm,video/mp4,audio/ogg,audio/mpeg,audio/wav,audio/webm" disabled={busy || !onImport} onchange={(e) => void importFile(e)} /></label>
    <label><input type="checkbox" data-fx-share bind:checked={shareWithPlayers} /> I have permission to serve this file to players</label>
    <label><input type="checkbox" data-fx-export bind:checked={includeInWorldFile} /> I have separate rights to redistribute this file in world archives</label>
    <span>{media.length} media file(s) in this world. Uploading or purchasing a pack does not grant sharing/redistribution rights.</span>
  </div>
  <details data-fx-rights>
    <summary>Review existing media permissions (including imported worlds)</summary>
    <div class="controls">
      <label>Media <select value={rightsHash} onchange={(event) => selectRights(event.currentTarget.value)}>
        {#each media as asset (asset.hash)}
          <option value={asset.hash}>{asset.name} ({asset.mime})</option>
        {/each}
      </select></label>
      <label><input type="checkbox" data-fx-rights-share bind:checked={rightsShare} /> I may serve this file to players</label>
      <label><input type="checkbox" data-fx-rights-export bind:checked={rightsExport} /> I may redistribute this file in a world archive</label>
      <button type="button" data-fx-update-rights disabled={busy || !rightsHash || !onAssetRights}
        onclick={() => void saveRights()}>Save media permissions</button>
    </div>
    <p class="hint">Restored files require this GM to review sharing and export rights again. A playable pack is not a redistribution license.</p>
  </details>
  <label>Name <input data-fx-name bind:value={name} placeholder="e.g. Arcane ward" /></label>
  <div class="controls">
    <label>Scene <select data-fx-scene bind:value={sceneId}>
      {#each scenes as sc (sc._id)}<option value={sc._id}>{sc.name}</option>{/each}
    </select></label>
    <label>Source <select bind:value={sourceId}><option value="">None</option>
      {#each scene?.tokens ?? [] as t (t._id)}<option value={t._id}>{t.name}</option>{/each}
    </select></label>
    <label>Target <select bind:value={targetId}><option value="">None</option>
      {#each scene?.tokens ?? [] as t (t._id)}<option value={t._id}>{t.name}</option>{/each}
    </select></label>
    <label>Audience <select data-fx-audience bind:value={draft.audience}>
      <option value="scene">Entitled scene viewers</option><option value="gm">GM only</option><option value="caller">Caller only</option>
    </select></label>
    <label><input type="checkbox" bind:checked={playerCallable} /> Published for player invocation</label>
    <label><input type="checkbox" data-fx-persistent checked={draft.persistent === true}
      onchange={(e) => draft = { ...draft, persistent: e.currentTarget.checked }} /> Persist / loop until stopped</label>
  </div>
  <div class="sections">
    {#each draft.sections as section, i (section.id)}
      <fieldset data-fx-section={section.id}>
        <legend>{i + 1}. {section.kind}</legend>
        <div class="controls">
          <label>Step <select value={section.kind} onchange={(e) => changeKind(i, (e.target as HTMLSelectElement).value as FxSection["kind"])}>
            <option value="text">Text</option><option value="image">Image / video</option><option value="sound">Sound</option><option value="camera">Camera</option><option value="wait">Wait</option>
          </select></label>
          <label>Start ms <input type="number" min="0" max="60000" step="50" bind:value={section.startMs} /></label>
          <label>Duration ms <input type="number" min="0" max="30000" step="50" bind:value={section.durationMs} /></label>
          <button type="button" aria-label={`Remove section ${i + 1}`} onclick={() => remove(i)}>×</button>
        </div>
        {#if section.kind !== "wait" && section.kind !== "camera"}
          <div class="controls" data-fx-replay>
            <label>Section play count <input type="number" min="1" max="8" step="1" disabled={draft.persistent}
              value={section.repeatCount ?? 1} oninput={(e) => changeReplayCount(i, e.currentTarget.value)} /></label>
            {#if (section.repeatCount ?? 1) > 1}
              <label>Pause between plays ms <input type="number" min="0" max="30000" step="50" disabled={draft.persistent}
                value={section.repeatDelayMs ?? 0} onchange={(e) => changeReplayGap(i, e.currentTarget.value)} /></label>
            {/if}
            <small>Separate clock-aligned plays (not motion cycles). One-shot only; 2–8 plays, ≤64 cues total, end before 60 s.</small>
          </div>
        {/if}
        {#if section.kind === "image" || section.kind === "sound"}
          <label>Media <select bind:value={section.assetId}>
            <option value="">Choose imported file…</option>
            {#each media.filter((m) => section.kind === "sound" ? m.mime.startsWith("audio/") : !m.mime.startsWith("audio/")) as asset (asset.hash)}
              <option value={asset.hash}>{asset.name} ({asset.mime})</option>
            {/each}
          </select></label>
        {/if}
        {#if section.kind === "text"}
          <label>Text <input maxlength="256" bind:value={section.text} /></label>
          <label>Color <input type="color" bind:value={section.color} /></label>
        {/if}
        {#if section.kind === "sound"}
          {@const units = scene?.grid.units ?? "units"}
          <div class="controls">
            <label>Volume <input type="number" min="0" max="1" step="0.05" bind:value={section.volume} /></label>
            <label>Channel <select data-fx-sound-channel value={soundChannelOf(section)}
              onchange={(e) => draft = { ...draft, sections: draft.sections.map((old, j) =>
                j === i && old.kind === "sound"
                  ? { ...old, channel: e.currentTarget.value as typeof old.channel } as FxSection : old) } }>
              {#each SOUND_CHANNELS as channel (channel)}
                <option value={channel}>{SOUND_CHANNEL_LABELS[channel]}</option>
              {/each}
            </select></label>
            <label>Fade in <input type="number" min="0" max={section.durationMs} step="50" data-fx-sound-fade-in
              value={section.fadeInMs ?? ""} oninput={(e) => draft = { ...draft, sections: draft.sections.map((old, j) =>
                j === i && old.kind === "sound" ? { ...old, fadeInMs: e.currentTarget.value === "" ? undefined
                  : Number(e.currentTarget.value) } as FxSection : old) } } /></label>
            <label>Fade out <input type="number" min="0" max={section.durationMs} step="50" data-fx-sound-fade-out
              value={section.fadeOutMs ?? ""} oninput={(e) => draft = { ...draft, sections: draft.sections.map((old, j) =>
                j === i && old.kind === "sound" ? { ...old, fadeOutMs: e.currentTarget.value === "" ? undefined
                  : Number(e.currentTarget.value) } as FxSection : old) } } /></label>
            <small>The channel is this device's fader, not a document field: each viewer mixes their own.
              A persistent loop fades in once and holds until stopped.</small>
          </div>
          <div class="controls">
            {#if section.at}
              <span>At {section.at.kind === "point" ? `${section.at.x}, ${section.at.y}` : section.at.kind} ·
                {section.radius ?? FX_SOUND_DEFAULT_RADIUS} {units}</span>
              <button type="button" data-fx-sound-pick disabled={!onOpenScene}
                onclick={() => void pickPoint(i, "sound")}>Pick on map…</button>
              <button type="button" data-fx-sound-clear
                onclick={() => draft = { ...draft, sections: draft.sections.map((old, j) =>
                  j === i && old.kind === "sound" ? (() => {
                    const { at: _at, radius: _r, pan: _p, muffle: _m, ...rest } = old;
                    void _at; void _r; void _p; void _m;
                    return rest as FxSection;
                  })() : old) }}>Hear everywhere</button>
            {:else}
              <button type="button" data-fx-sound-pick disabled={!onOpenScene}
                onclick={() => void pickPoint(i, "sound")}>Place on map…</button>
              <small>A sound with no position plays for everyone at the authored volume.</small>
            {/if}
          </div>
          {#if section.at}
            <div class="controls">
              <label>Hear up to ({units}) <input type="number" data-fx-sound-radius
                min={SOUND_RADIUS_LIMITS.min} max={SOUND_RADIUS_LIMITS.max} step="1"
                value={section.radius ?? FX_SOUND_DEFAULT_RADIUS}
                oninput={(e) => draft = { ...draft, sections: draft.sections.map((old, j) =>
                  j === i && old.kind === "sound" ? { ...old, radius: e.currentTarget.value === ""
                    ? undefined : Number(e.currentTarget.value) } as FxSection : old) } } /></label>
              <label><input type="checkbox" data-fx-sound-pan checked={section.pan === true}
                onchange={(e) => draft = { ...draft, sections: draft.sections.map((old, j) =>
                  j === i && old.kind === "sound" ? { ...old, pan: e.currentTarget.checked } as FxSection : old) } } />Pan left/right</label>
              <label><input type="checkbox" data-fx-sound-muffle checked={section.muffle === true}
                onchange={(e) => draft = { ...draft, sections: draft.sections.map((old, j) =>
                  j === i && old.kind === "sound" ? { ...old, muffle: e.currentTarget.checked } as FxSection : old) } } />Dulled through walls</label>
            </div>
            <small>Volume falls from the source to that rim, measured for each listener from
              their own token — or, for a viewer with nothing of their own on the map, from the centre of their view.
              Panning and wall-dulling need a stereo-capable device; one that has neither still plays the sound,
              quieter with distance, and says so in its own report.</small>
          {/if}
        {/if}
        {#if section.kind === "camera"}
          <div class="controls">
            <label>Seen by <select data-fx-camera-audience value={section.audience ?? "scene"}
              onchange={(e) => changeCameraAudience(i, e.currentTarget.value)}>
              <option value="scene">Everyone watching this timeline</option>
              <option value="gm">GMs only</option>
              <option value="caller">Only whoever runs it</option>
            </select></label>
            <label>Camera <select data-fx-camera-mode value={section.mode}
              onchange={(e) => changeCameraMode(i, (e.target as HTMLSelectElement).value as "pan" | "shake" | "path")}>
              <option value="pan">Pan to a point</option><option value="shake">Shake in place</option>
              <option value="path">Path through waypoints</option>
            </select></label>
            {#if section.mode === "pan"}
              <label>Destination <select data-fx-camera-destination value={section.to.kind}
                onchange={(e) => changeCameraDestination(i, (e.target as HTMLSelectElement).value as "point" | "source" | "target")}>
                <option value="point">Point</option><option value="source">Source token</option><option value="target">Target token</option>
              </select></label>
              {#if section.to.kind === "point"}
                <label>Camera X <input type="number" min="0" data-fx-camera-x
                  value={section.to.x} oninput={(e) => draft = { ...draft, sections: draft.sections.map((old, j) =>
                    j === i && old.kind === "camera" && old.mode === "pan"
                      ? { ...old, to: { kind: "point", x: Number(e.currentTarget.value), y: old.to.y } } as FxSection : old) } } /></label>
                <label>Camera Y <input type="number" min="0" data-fx-camera-y
                  value={section.to.y} oninput={(e) => draft = { ...draft, sections: draft.sections.map((old, j) =>
                    j === i && old.kind === "camera" && old.mode === "pan"
                      ? { ...old, to: { kind: "point", x: old.to.x, y: Number(e.currentTarget.value) } } as FxSection : old) } } /></label>
                {#if onPickAnchor}
                  <button type="button" data-fx-pick="camera" disabled={!onOpenScene}
                    title={onOpenScene ? "Click the map to choose where the camera looks" : "Open this timeline's scene first"}
                    onclick={() => void pickPoint(i, "camera")}>Pick on map…</button>
                {/if}
              {/if}
              <label>Easing <select data-fx-camera-easing value={section.easing ?? "linear"}
                onchange={(e) => draft = { ...draft, sections: draft.sections.map((old, j) =>
                  j === i && old.kind === "camera" && old.mode === "pan"
                    ? { ...old, easing: e.currentTarget.value as FxEasing } as FxSection : old) } }>
                <option value="linear">Linear</option><option value="easeIn">Ease in</option>
                <option value="easeOut">Ease out</option><option value="easeInOut">Ease in/out</option>
              </select></label>
              <label>Zoom at the end <input type="number" min="0.1" max="10" step="0.05" data-fx-camera-zoom
                value={section.zoom ?? ""} oninput={(e) => changeCameraZoom(i, e.currentTarget.value)} /></label>
              <small>Leaves the view on the destination when the section ends; the viewer's own drag cancels it.</small>
            {:else if section.mode === "path"}
              <div class="waypoints" data-fx-waypoints>
                <small>The tour starts wherever each viewer already is, then visits these in order
                  and stays on the last one. Every waypoint is resolved and bounds-checked by the host.</small>
                {#each section.points as point, way (way)}
                  <div class="row" data-fx-waypoint={way}>
                    <strong>{way + 1}.</strong>
                    <select data-fx-waypoint-kind={way} value={point.kind}
                      onchange={(e) => changeWaypointKind(i, way, (e.target as HTMLSelectElement).value as "point" | "source" | "target")}>
                      <option value="point">Point</option><option value="source">Source token</option>
                      <option value="target">Target token</option>
                    </select>
                    {#if point.kind === "point"}
                      <label>X <input type="number" min="0" data-fx-waypoint-x={way} value={point.x}
                        oninput={(e) => changeWaypoint(i, way, { kind: "point", x: Number(e.currentTarget.value),
                          y: point.y } as never)} /></label>
                      <label>Y <input type="number" min="0" data-fx-waypoint-y={way} value={point.y}
                        oninput={(e) => changeWaypoint(i, way, { kind: "point", x: point.x,
                          y: Number(e.currentTarget.value) } as never)} /></label>
                      {#if onPickAnchor}
                        <button type="button" data-fx-waypoint-pick={way} disabled={!onOpenScene}
                          title={onOpenScene ? "Click the map to place this waypoint" : "Open this timeline's scene first"}
                          onclick={() => void pickPoint(i, "waypoint", way)}>Pick on map…</button>
                      {/if}
                    {/if}
                    <button type="button" data-fx-waypoint-remove={way} disabled={section.points.length <= 2}
                      onclick={() => removeWaypoint(i, way)}>Remove</button>
                  </div>
                {/each}
                <button type="button" data-fx-waypoint-add disabled={section.points.length >= 8}
                  onclick={() => addWaypoint(i)}>Add waypoint</button>
              </div>
              <label>Easing <select data-fx-camera-easing value={section.easing ?? "linear"}
                onchange={(e) => draft = { ...draft, sections: draft.sections.map((old, j) =>
                  j === i && old.kind === "camera" && old.mode === "path"
                    ? { ...old, easing: e.currentTarget.value as FxEasing } as FxSection : old) } }>
                <option value="linear">Linear</option><option value="easeIn">Ease in</option>
                <option value="easeOut">Ease out</option><option value="easeInOut">Ease in/out</option>
              </select></label>
              <label>Zoom at the end <input type="number" min="0.1" max="10" step="0.05" data-fx-camera-zoom
                value={section.zoom ?? ""} oninput={(e) => changeCameraZoom(i, e.currentTarget.value)} /></label>
              <small>One leg per waypoint, eased alike; a viewer's own drag or zoom still takes the map back.</small>
            {:else}
              <label>Shake intensity <input type="number" min="0.05" max="1" step="0.05" data-fx-camera-intensity
                value={section.intensity} oninput={(e) => draft = { ...draft, sections: draft.sections.map((old, j) =>
                  j === i && old.kind === "camera" && old.mode === "shake"
                    ? { ...old, intensity: Number(e.currentTarget.value) } as FxSection : old) } } /></label>
              <small>Bounded, decaying, and always returns the view exactly where it started.</small>
            {/if}
            <small>A camera section cannot loop or replay, and at most eight fit in one timeline.
              A viewer outside "Seen by" receives the rest of the run without this section, so their
              payload never says where someone else's view went.</small>
          </div>
        {/if}
        {#if section.kind === "image" || section.kind === "text"}
          <div class="controls">
            <label>Anchor <select value={section.at.kind} onchange={(e) => changeAnchor(i, (e.target as HTMLSelectElement).value as "point" | "source" | "target")}>
              <option value="point">Point</option><option value="source">Source token</option><option value="target">Target token</option>
            </select></label>
            {#if section.at.kind === "point"}
              <label>X <input type="number" min="0" bind:value={section.at.x} /></label>
              <label>Y <input type="number" min="0" bind:value={section.at.y} /></label>
              {#if onPickAnchor}
                <button type="button" data-fx-pick="at" disabled={!onOpenScene}
                  title={onOpenScene ? "Click the map to set this point" : "Open this timeline's scene first"}
                  onclick={() => void pickPoint(i, "at")}>Pick on map…</button>
                <button type="button" data-fx-drag disabled={!onOpenScene}
                  title={onOpenScene ? "Drag on the map from the start to the destination" : "Open this timeline's scene first"}
                  onclick={() => void dragSection(i)}>Drag source → target…</button>
              {/if}
            {/if}
            <label>Destination <select value={section.to?.kind ?? "none"} onchange={(event) =>
                changeDestination(i, event.currentTarget.value as "none" | "point" | "source" | "target")}>
              <option value="none">Stay</option><option value="point">Point</option>
              <option value="source">Source token</option><option value="target">Target token</option>
            </select></label>
            {#if section.to?.kind === "point"}
              <label>To X <input type="number" min="0" bind:value={section.to.x} /></label>
              <label>To Y <input type="number" min="0" bind:value={section.to.y} /></label>
              {#if onPickAnchor}
                <button type="button" data-fx-pick="to" disabled={!onOpenScene}
                  title={onOpenScene ? "Click the map to set the destination" : "Open this timeline's scene first"}
                  onclick={() => void pickPoint(i, "to")}>Pick on map…</button>
              {/if}
            {/if}
            {#if section.to || section.scaleTo !== undefined || section.spinDeg !== undefined ||
              section.filterTo !== undefined || section.mask?.lengthTo !== undefined ||
              section.mask?.spinDeg !== undefined}
              <!-- The easing curve belongs to any animation, not only to a move: a growing,
                   spinning or deepening visual — or a region of its own — eases with the
                   same curve as a flying one. -->
              <label>Easing <select data-fx-easing bind:value={section.easing}>
                <option value="linear">Linear</option><option value="easeIn">Ease in</option>
                <option value="easeOut">Ease out</option><option value="easeInOut">Ease in/out</option>
              </select></label>
            {/if}
            {#if section.to}
              {#if section.kind === "image"}
                <label><input type="checkbox" bind:checked={section.stretch}
                  onchange={() => { if (section.stretch) section.repeats = undefined; }} />Stretch toward destination</label>
              {/if}
              {#if section.kind !== "image" || !section.stretch}
                <label>Motion cycles <input type="number" min="1" max="20" bind:value={section.repeats} /></label>
              {/if}
            {/if}
            {#if section.kind === "image"}
              <label>Tint <input type="color" bind:value={section.tint} /></label>
            {/if}
            <label>Blend <select data-fx-blend value={section.blend ?? "normal"}
              onchange={(e) => changeBlend(i, e.currentTarget.value)}>
              <option value="normal">Normal</option>
              <option value="add">Add — glow</option>
              <option value="multiply">Multiply — shadow</option>
              <option value="screen">Screen</option>
              <option value="overlay">Overlay</option>
              <option value="darken">Darken</option>
              <option value="lighten">Lighten</option>
            </select></label>
            <label>Filter <select data-fx-filter value={section.filter?.kind ?? "none"}
              onchange={(e) => changeFilter(i, e.currentTarget.value)}>
              <option value="none">None</option>
              <option value="blur">Blur</option>
              <option value="grayscale">Grayscale</option>
              <option value="brightness">Brightness</option>
              <option value="saturate">Saturation</option>
            </select></label>
            {#if section.filter}
              {@const range = FX_FILTER_RANGES[section.filter.kind]}
              <label>Filter amount ({range.unit}) <input type="number" data-fx-filter-strength
                min={range.min} max={range.max} step="0.1" value={section.filter.strength ?? range.default}
                oninput={(e) => changeFilterStrength(i, e.currentTarget.value)} /></label>
              <label>Move to ({range.unit}) <input type="number" data-fx-filter-to
                min={range.min} max={range.max} step="0.1" value={section.filterTo ?? ""}
                placeholder="steady" oninput={(e) => changeFilterTo(i, e.currentTarget.value)} /></label>
              <small>{filterHint(section)}</small>
            {/if}
            <label>Mask <select data-fx-mask-kind value={section.mask?.kind ?? "none"}
              onchange={(e) => changeMask(i, e.currentTarget.value)}>
              <option value="none">None</option>
              <option value="circle">Circle</option>
              <option value="cone">Cone</option>
              <option value="ray">Ray</option>
              <option value="rect">Rectangle</option>
            </select></label>
            {#if section.mask}
              {@const mask = section.mask}
              {@const units = scene?.grid.units ?? "units"}
              <label>Mask size ({units}) <input type="number" data-fx-mask-length
                min={FX_MASK_LIMITS.min} max={FX_MASK_LIMITS.max} step="1" value={mask.length}
                oninput={(e) => changeMaskField(i, { length: Number(e.currentTarget.value) })} /></label>
              {#if mask.kind === "ray" || mask.kind === "rect"}
                <label>Mask width ({units}) <input type="number" data-fx-mask-width
                  min={FX_MASK_LIMITS.min} max={FX_MASK_LIMITS.max} step="1" value={mask.width ?? 5}
                  oninput={(e) => changeMaskField(i, { width: Number(e.currentTarget.value) })} /></label>
              {/if}
              {#if mask.kind === "cone"}
                <label>Mask spread (°) <input type="number" data-fx-mask-spread
                  min={FX_MASK_LIMITS.spreadMin} max={FX_MASK_LIMITS.spreadMax} step="1" value={mask.spread ?? 53.13}
                  oninput={(e) => changeMaskField(i, { spread: Number(e.currentTarget.value) })} /></label>
              {/if}
              {#if mask.kind !== "circle"}
                <label>Mask angle (°) <input type="number" data-fx-mask-angle min="-360" max="360" step="15"
                  value={mask.angle ?? 0} oninput={(e) => changeMaskField(i, { angle: Number(e.currentTarget.value) })} /></label>
              {/if}
              {#if mask.walls !== true}
                <label>Grow to ({units}) <input type="number" data-fx-mask-length-to
                  min={FX_MASK_LIMITS.min} max={FX_MASK_LIMITS.max} step="1" value={mask.lengthTo ?? ""}
                  placeholder="steady" oninput={(e) => changeMaskAnimation(i, "lengthTo", e.currentTarget.value)} /></label>
                {#if mask.kind !== "circle"}
                  <label>Turn (°) <input type="number" data-fx-mask-spin min={-FX_SPIN_LIMIT}
                    max={FX_SPIN_LIMIT} step="15" value={mask.spinDeg ?? ""} placeholder="still"
                    oninput={(e) => changeMaskAnimation(i, "spinDeg", e.currentTarget.value)} /></label>
                {/if}
              {/if}
              <label><input type="checkbox" data-fx-mask-walls checked={mask.walls === true}
                onchange={(e) => changeMaskWalls(i, e.currentTarget.checked)} />Stop at walls (sight)</label>
              <label><input type="checkbox" data-fx-mask-invert checked={mask.invert === true}
                onchange={(e) => changeMaskField(i, { invert: e.currentTarget.checked })} />Cut out (hide what is inside the mask)</label>
              <small>The mask is measured against this scene's grid ({units}) around the anchor and travels with it; the host resolves it and refuses a shape it cannot draw.
                {#if mask.walls === true}
                  Trimmed where a wall blocks sight — the same rule the fog uses, doors included — and baked into the shape, so it cannot grow or turn.
                {:else if mask.lengthTo !== undefined || mask.spinDeg !== undefined}
                  A region that grows or turns does so inside this section, on its own eased curve — {section.repeats !== undefined && section.repeats !== 1 ? `a grow restarts in each of its ${section.repeats} cycles, a turn keeps going.` : "eased across the section."}
                {/if}</small>
            {/if}
            {#if section.at.kind !== "point" || section.to && section.to.kind !== "point"}
              <label><input type="checkbox" data-fx-follow bind:checked={section.follow} />Follow visible token anchors</label>
            {/if}
            <label>Layer <select bind:value={section.layer}>
              <option value="aboveTokens">Above tokens, beneath fog</option><option value="belowTokens">Below tokens</option>
            </select></label>
            <label>Scale <input type="number" min={FX_SCALE_LIMITS.min} max={FX_SCALE_LIMITS.max}
              step="0.1" bind:value={section.scale} /></label>
            <label>Grow/shrink to <input type="number" data-fx-scale-to
              min={FX_SCALE_LIMITS.min} max={FX_SCALE_LIMITS.max} step="0.1" value={section.scaleTo ?? ""}
              placeholder="stay" oninput={(e) => changeScaleTo(i, e.currentTarget.value)} /></label>
            <label>Spin (°) <input type="number" data-fx-spin min={-FX_SPIN_LIMIT} max={FX_SPIN_LIMIT}
              step="15" value={section.spinDeg ?? ""} placeholder="none"
              oninput={(e) => changeSpin(i, e.currentTarget.value)} /></label>
            {#if section.scaleTo !== undefined || section.spinDeg !== undefined}
              <small>{section.repeats === undefined || section.repeats === 1
                ? "Both ends of the section, eased like its motion."
                : `Applied per motion cycle — ${section.repeats} cycles, so the spin turns that many times.`}</small>
            {/if}
            <label>Opacity <input type="number" min="0" max="1" step="0.1" bind:value={section.opacity} /></label>
            <label>Fade in <input type="number" min="0" step="50" bind:value={section.fadeInMs} /></label>
            <label>Fade out <input type="number" min="0" step="50" bind:value={section.fadeOutMs} /></label>
          </div>
        {/if}
      </fieldset>
    {/each}
  </div>
  <div class="controls">
    <span>Add section:</span>
    <button type="button" onclick={() => add("text")}>Text</button>
    <button type="button" onclick={() => add("image")}>Image / video</button>
    <button type="button" onclick={() => add("sound")}>Sound</button>
    <button type="button" onclick={() => add("camera")}>Camera</button>
    <button type="button" onclick={() => add("wait")}>Wait</button>
    <button type="button" data-fx-save onclick={save}>Save timeline</button>
    {#if editing}<button type="button" data-fx-run onclick={() => run(editing)}>Run saved</button>{/if}
    {#if onPreview}
      <button type="button" data-fx-preview disabled={draft.sections.length === 0 || !onOpenScene}
        title={onOpenScene ? "Render this draft locally; nothing is committed"
          : "Open this timeline's scene first"}
        onclick={() => void preview()}>Preview on canvas</button>
    {/if}
    {#if previewRun}
      <button type="button" data-fx-preview-stop onclick={stopPreview}>Stop preview</button>
    {/if}
  </div>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  {#if status}<p role="status" data-fx-status>{status}</p>{/if}
  {#if fitnessIssues.length > 0}
    <p class="warn" role="status" data-fx-fitness>This timeline may not reach every viewer: {fitnessIssues.join("; ")}</p>
  {/if}
  {#if placements.length > 0}
    <!-- SQ-10: named placements reuse the author's own spot in later sections; the
         overlay offers them, and this list is the record of what was named. -->
    <div class="placements" data-fx-placements>
      <small>{placements.length} named placement{placements.length === 1 ? "" : "s"} — offered for reuse on the next pick</small>
      {#each placements as placement (placement.name)}
        <span data-fx-placement={placement.name}>{placement.name} ({Math.round(placement.point.x)}, {Math.round(placement.point.y)})</span>
      {/each}
    </div>
  {/if}
  <h4>Saved timelines</h4>
  <ul>{#each macros as macro (macro._id)}
    <li data-fx-macro-id={macro._id}><strong>{macro.name}</strong> <small>{macro.sequence?.sections.length ?? 0} sections</small>
      <button type="button" onclick={() => pick(macro)}>Edit</button>
      <button type="button" onclick={() => run(macro._id)}>Run</button>
    </li>
  {/each}</ul>
  {#if editing}
    <!-- D-311: the timeline's item binding. Authoring only — the item's own cast fires it. -->
    <div class="binding" data-fx-binding={editing}>
      <h4>Bind to an item</h4>
      <div class="controls">
        <label>Actor <select data-fx-binding-actor value={bindActorId}
          onchange={(event) => selectBindActor(event.currentTarget.value)}>
          <option value="">— actor —</option>
          {#each actors as actor (actor._id)}
            <option value={actor._id}>{actor.name}</option>
          {/each}
        </select></label>
        <label>Item <select data-fx-binding-item bind:value={bindItemId} disabled={!bindActorId}>
          <option value="">— item —</option>
          {#each boundItems as item (item._id)}
            <option value={item._id}>{item.name}</option>
          {/each}
        </select></label>
        <label>On a failed use <select data-fx-binding-failure bind:value={bindFailureId}>
          <option value="">play nothing</option>
          {#each otherTimelines as macro (macro._id)}
            <option value={macro._id}>{macro.name}</option>
          {/each}
        </select></label>
        <fieldset class="events" data-fx-binding-events>
          <legend>Fires when</legend>
          {#each FX_ITEM_EVENTS as event (event)}
            <label title={FX_ITEM_EVENT_CONTRACT[event].facts}>
              <input type="checkbox" data-fx-binding-event={event}
                checked={bindEvents.includes(event)}
                onchange={(e) => toggleBindEvent(event, e.currentTarget.checked)} />{event}
            </label>
          {/each}
        </fieldset>
        <label>Recognition <select data-fx-binding-recognition bind:value={bindRecognition}>
          {#each FX_RECOGNITION_MODES as mode (mode)}
            <option value={mode}>{mode}</option>
          {/each}
        </select></label>
        <label><input type="checkbox" data-fx-binding-enabled bind:checked={bindEnabled} />Enabled</label>
        <button type="button" data-fx-binding-save onclick={saveBinding}>Save binding</button>
        {#if macros.find((macro) => macro._id === editing)?.fxItem}
          <button type="button" data-fx-binding-remove onclick={removeBinding}>Remove binding</button>
        {/if}
      </div>
      <small>The cue is requested <strong>after</strong> the moment it names has committed, so a
        failed moment can play its own cue and a refused one plays nothing. What counts as a
        failure here: {bindEventHelp}. One timeline may fire on each moment (a swing cue and a
        charge-burn cue can share a weapon, but not the same moment). The binding never rolls,
        damages or spends anything, and it grants nothing: a player still needs the timeline
        published for them ("players may run this") or the host refuses the cue.</small>
    </div>
  {/if}
  <h4>Presets</h4>
  <div class="presets" data-fx-presets>
    <div class="controls">
      <label>Preset name <input data-fx-preset-name bind:value={presetName}
        maxlength={FX_PRESET_LIMITS.name} placeholder="e.g. Fireball look" /></label>
      <button type="button" data-fx-preset-save onclick={savePreset}>Save draft as preset</button>
      <small>A preset is the draft's <strong>sections</strong> — not its persistence, audience or bound tokens.
        Loading one replaces the draft; nothing reaches the table until the timeline is saved and run,
        and a preset never copies a named placement.</small>
    </div>
    {#if presets.length === 0}
      <small data-fx-presets-empty>No presets saved in this world yet.</small>
    {:else}
      <ul>{#each presets as preset (preset._id)}
        <li data-fx-preset-id={preset._id}>
          <input data-fx-preset-rename value={preset.name} aria-label="Preset name"
            maxlength={FX_PRESET_LIMITS.name}
            onchange={(event) => renamePreset(preset, event.currentTarget.value)} />
          <small>{preset.preset?.sections.length ?? 0} sections</small>
          <button type="button" data-fx-preset-load onclick={() => loadPreset(preset)}>Load</button>
          <button type="button" data-fx-preset-update onclick={() => updatePreset(preset)}>Update from draft</button>
          <button type="button" data-fx-preset-delete onclick={() => deletePreset(preset)}>Delete</button>
        </li>
      {/each}</ul>
    {/if}
  </div>
</section>

<style>
  .fx-wizard { display: grid; gap: 8px; font-size: .8rem; }
  header, .controls, .library, li { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
  header { justify-content: space-between; } h3, h4 { margin: 0; }
  label { display: inline-flex; align-items: center; gap: 4px; }
  input:not([type="checkbox"]):not([type="file"]), select { min-width: 72px; max-width: 220px; }
  input[type="number"] { width: 70px; }
  .hint { margin: 0; color: #aab6c6; }
  .waypoints { display: grid; gap: 4px; padding: 5px; border: 1px dashed #5d7091; border-radius: 4px; }
  .waypoints .row { align-items: center; }
  .waypoints strong { min-width: 1.4em; }
  .placements { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; color: #cfe6d8; }
  .placements span { border: 1px solid #4f7a61; border-radius: 3px; padding: 1px 5px; }
  .sections { display: grid; gap: 6px; max-height: 270px; overflow: auto; }
  fieldset { border: 1px solid #53586a; border-radius: 4px; padding: 6px; min-width: 0; display: grid; gap: 5px; }
  legend { color: #e6d6a1; }
  li { margin: 4px 0; } li small { color: #aaa; }
  .error { color: #ff9e9e; }
  .warn { color: #ffd79a; font-size: 0.7875rem; margin: 0; }
</style>
