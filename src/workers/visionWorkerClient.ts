/**
 * §9 vision worker client — Promise-based polygon requests with an
 * injectable Worker ctor (tests pass an inline ctor; the app layer passes
 * the vite `?worker&inline` import). `InlineVisionWorker` runs the same pure
 * module in-context (Node tests, same-thread fallback).
 */
import { visibilityPolygon, type Segment } from "../canvas/vision/polygon";

export interface VisionComputer {
  /** Flat polygon [x0,y0,…] for a viewer origin (transferable-friendly). */
  compute(
    ox: number,
    oy: number,
    segments: Float32Array,
    radius: number | null,
  ): Promise<Float32Array>;
  terminate(): void;
}

export class InlineVisionWorker implements VisionComputer {
  compute(
    ox: number,
    oy: number,
    segments: Float32Array,
    radius: number | null,
  ): Promise<Float32Array> {
    const segs: Segment[] = [];
    for (let i = 0; i + 3 < segments.length; i += 4) {
      segs.push({
        x1: segments[i] ?? 0,
        y1: segments[i + 1] ?? 0,
        x2: segments[i + 2] ?? 0,
        y2: segments[i + 3] ?? 0,
      });
    }
    return Promise.resolve(visibilityPolygon(ox, oy, segs, radius));
  }

  terminate(): void {}
}

type WorkerResponse = import("./vision.worker").VisionWorkerResponse;

export class WorkerVisionComputer implements VisionComputer {
  private worker: Worker | null = null;
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (p: Float32Array) => void; reject: (e: Error) => void }
  >();

  constructor(private readonly workerCtor: new () => Worker) {}

  private ensure(): Worker {
    if (this.worker) return this.worker;
    const worker = new this.workerCtor();
    worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
      const waiter = this.pending.get(ev.data.id);
      if (!waiter) return;
      this.pending.delete(ev.data.id);
      if (ev.data.ok && ev.data.poly) waiter.resolve(ev.data.poly);
      else waiter.reject(new Error(ev.data.error ?? "vision worker failed"));
    };
    worker.onerror = () => {
      for (const w of this.pending.values()) w.reject(new Error("vision worker crashed"));
      this.pending.clear();
    };
    this.worker = worker;
    return worker;
  }

  compute(
    ox: number,
    oy: number,
    segments: Float32Array,
    radius: number | null,
  ): Promise<Float32Array> {
    const worker = this.ensure();
    const id = this.nextId++;
    const copy = segments.slice(); // caller keeps its array; transfer the copy
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      worker.postMessage({ id, type: "poly" as const, ox, oy, segments: copy, radius }, [
        copy.buffer,
      ]);
    });
  }

  terminate(): void {
    this.worker?.terminate();
    this.worker = null;
    for (const w of this.pending.values()) w.reject(new Error("vision worker terminated"));
    this.pending.clear();
  }
}
