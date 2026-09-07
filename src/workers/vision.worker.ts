/// <reference lib="webworker" />
/**
 * §9 vision.worker.ts — visibility polygons off the main thread. Requests
 * carry the wall segments (transferable Float32Array quads) and an origin;
 * responses carry the flat polygon (transferable back). Same sandbox rules
 * as sim.worker (no fetch/WS/XHR/importScripts/IDB).
 */
import { visibilityPolygon } from "../canvas/vision/polygon";

export interface VisionWorkerRequest {
  id: number;
  type: "poly";
  /** Viewer origin. */
  ox: number;
  oy: number;
  /** Flat segment quads [x1,y1,x2,y2, …] (sight-blocking only). */
  segments: Float32Array;
  /** Sight radius cap (world units). */
  radius: number | null;
}

export interface VisionWorkerResponse {
  id: number;
  ok: boolean;
  /** Flat polygon [x0,y0,…] (transfered). */
  poly?: Float32Array;
  error?: string;
}

const hasScope = typeof self !== "undefined";
const ctx = hasScope ? (self as unknown as DedicatedWorkerGlobalScope) : null;

function sandbox(): void {
  if (typeof self === "undefined") return; // Node (tests import the handler)
  // §12 sandbox parity with sim.worker
  const g = self as unknown as Record<string, unknown>;
  for (const k of ["fetch", "XMLHttpRequest", "importScripts", "indexedDB"]) {
    try {
      Reflect.deleteProperty(g, k);
    } catch {
      /* non-configurable own prop — fall through to shadow */
    }
    // prototype members (fetch/importScripts/indexedDB in Chromium) survive
    // delete; shadow them with a locked undefined own property
    if (typeof g[k] !== "undefined") {
      try {
        Object.defineProperty(g, k, {
          value: undefined,
          writable: false,
          enumerable: true,
          configurable: false,
        });
      } catch {
        /* already non-configurable */
      }
    }
  }
}
sandbox();

function onMessage(ev: MessageEvent<VisionWorkerRequest>): void {
  if (!ctx) return; // no worker scope (Node import for handler tests)
  const req = ev.data;
  const respond = (res: VisionWorkerResponse): void => {
    const transfer = res.poly ? [res.poly.buffer as ArrayBuffer] : [];
    ctx.postMessage(res, transfer);
  };
  try {
    const segs: Array<{ x1: number; y1: number; x2: number; y2: number }> = [];
    for (let i = 0; i + 3 < req.segments.length; i += 4) {
      segs.push({
        x1: req.segments[i] ?? 0,
        y1: req.segments[i + 1] ?? 0,
        x2: req.segments[i + 2] ?? 0,
        y2: req.segments[i + 3] ?? 0,
      });
    }
    const poly = visibilityPolygon(req.ox, req.oy, segs, req.radius);
    respond({ id: req.id, ok: true, poly });
  } catch (err) {
    respond({ id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}

if (ctx) {
  ctx.onmessage = (ev: MessageEvent<VisionWorkerRequest>): void => onMessage(ev);
}
export const __testHandler = onMessage;
