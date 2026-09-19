/**
 * §9 vision computer for the app shells (D-250): the real `vision.worker` (inline data-URL
 * bundle, D-059) with a same-thread fallback — no `Worker` in this context, or a worker
 * that fails its first request (a CSP that forbids blob/data workers) — so explored fog
 * keeps working everywhere the canvas does. Kept apart from `visionWorkerClient` so the
 * pure client stays importable without the bundler's `?worker&inline` transform.
 */
import VisionWorkerCtor from "./vision.worker.ts?worker&inline";
import {
  InlineVisionWorker,
  WorkerVisionComputer,
  type VisionComputer,
} from "./visionWorkerClient";

class ResilientVisionComputer implements VisionComputer {
  private inline: InlineVisionWorker | null = null;

  constructor(private readonly worker: WorkerVisionComputer) {}

  async compute(
    ox: number,
    oy: number,
    segments: Float32Array,
    radius: number | null,
  ): Promise<Float32Array> {
    if (this.inline) return this.inline.compute(ox, oy, segments, radius);
    try {
      return await this.worker.compute(ox, oy, segments, radius);
    } catch {
      this.inline = new InlineVisionWorker();
      this.worker.terminate();
      return this.inline.compute(ox, oy, segments, radius);
    }
  }

  terminate(): void {
    this.worker.terminate();
    this.inline = null;
  }
}

export function createVisionComputer(): VisionComputer {
  if (typeof Worker === "undefined") return new InlineVisionWorker();
  return new ResilientVisionComputer(
    new WorkerVisionComputer(VisionWorkerCtor as unknown as new () => Worker),
  );
}
