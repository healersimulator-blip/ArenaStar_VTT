/**
 * The wizard's local-preview contract. A preview renders an **unsaved draft** for
 * its author on the tab's own canvas: it is not a host request, it commits no
 * world op, it creates no durable `fxInstance` and no recipient receives a cue.
 * The `runId` is what lets the panel stop exactly the cue it started.
 */
import type { FxSequence } from "../../core/fx";

export type FxPreviewResult = { ok: true; runId: string } | { ok: false; error: string };
export type PreviewFxSequence = (
  sequence: FxSequence,
  sceneId: string,
  sourceTokenId: string,
  targetTokenId: string,
) => Promise<FxPreviewResult>;
