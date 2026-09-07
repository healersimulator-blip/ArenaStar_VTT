/**
 * §10 window manager — pure geometry/state core for floating windows
 * (sheets, journals, image popouts, GM tools). The Svelte layer renders
 * WindowManager state; all logic here is testable without a DOM.
 */
export interface WindowSpec {
  id: string;
  title: string;
  /** Discriminator for the renderer (e.g. "permissions", "journal", "macro"). */
  kind: string;
  x: number;
  y: number;
  width: number;
  height: number;
  z: number;
  minimized: boolean;
  /** Renderer payload (doc id etc.). */
  data?: Record<string, string>;
}

export interface WindowBounds {
  width: number;
  height: number;
}

export const MIN_WINDOW_W = 180;
export const MIN_WINDOW_H = 120;

export interface WindowEvents {
  onChanged(): void;
}

/** Open/focus/move/resize/z-order state machine (§10). */
export class WindowManager {
  private windows: WindowSpec[] = [];
  private nextZ = 10;
  private readonly listeners = new Set<() => void>();

  private bounds: WindowBounds;

  constructor(bounds: WindowBounds) {
    this.bounds = bounds;
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private changed(): void {
    for (const cb of this.listeners) cb();
  }

  list(): readonly WindowSpec[] {
    return this.windows;
  }

  get(id: string): WindowSpec | null {
    return this.windows.find((w) => w.id === id) ?? null;
  }

  /** Open (or focus + restore if already open) at a position; clamped in-bounds. */
  open(
    spec: Omit<WindowSpec, "z" | "minimized"> & { z?: number; minimized?: boolean },
  ): WindowSpec {
    const existing = this.get(spec.id);
    if (existing) {
      this.focus(spec.id);
      const merged: WindowSpec = { ...existing, minimized: false };
      this.windows = this.windows.map((w) => (w.id === spec.id ? merged : w));
      this.changed();
      return merged;
    }
    const width = clamp(spec.width, MIN_WINDOW_W, Math.max(MIN_WINDOW_W, this.bounds.width));
    const height = clamp(spec.height, MIN_WINDOW_H, Math.max(MIN_WINDOW_H, this.bounds.height));
    const x = clamp(spec.x, 0, Math.max(0, this.bounds.width - width));
    const y = clamp(spec.y, 0, Math.max(0, this.bounds.height - height));
    const win: WindowSpec = {
      ...spec,
      width,
      height,
      x,
      y,
      z: ++this.nextZ,
      minimized: false,
    };
    this.windows = [...this.windows, win];
    this.changed();
    return win;
  }

  close(id: string): void {
    this.windows = this.windows.filter((w) => w.id !== id);
    this.changed();
  }

  /** Raise to the top (focus); the caller wires pointerdown → focus. */
  focus(id: string): void {
    const top = Math.max(...this.windows.map((w) => w.z), 0);
    let changed = false;
    this.windows = this.windows.map((w) => {
      if (w.id !== id || w.z === top) return w;
      changed = true;
      return { ...w, z: ++this.nextZ };
    });
    if (changed) this.changed();
  }

  /** Top-most window id (active window). */
  activeId(): string | null {
    let best: WindowSpec | null = null;
    for (const w of this.windows) if (!best || w.z > best.z) best = w;
    return best?.id ?? null;
  }

  /** Drag by delta; keeps the title bar reachable (never fully off-screen). */
  move(id: string, dx: number, dy: number): void {
    this.windows = this.windows.map((w) => {
      if (w.id !== id) return w;
      const x = clamp(w.x + dx, -(w.width - 60), Math.max(0, this.bounds.width - 60));
      const y = clamp(w.y + dy, 0, Math.max(0, this.bounds.height - 24));
      return { ...w, x, y };
    });
    this.changed();
  }

  /** Absolute move (drop); same clamping. */
  moveTo(id: string, x: number, y: number): void {
    const win = this.get(id);
    if (win) this.move(id, x - win.x, y - win.y);
  }

  /** Resize keeping min sizes and parent bounds. */
  resize(id: string, width: number, height: number): void {
    this.windows = this.windows.map((w) => {
      if (w.id !== id) return w;
      const nextW = clamp(width, MIN_WINDOW_W, this.bounds.width - w.x);
      const nextH = clamp(height, MIN_WINDOW_H, this.bounds.height - w.y);
      return { ...w, width: nextW, height: nextH };
    });
    this.changed();
  }

  toggleMinimize(id: string): void {
    this.windows = this.windows.map((w) => (w.id === id ? { ...w, minimized: !w.minimized } : w));
    this.changed();
  }

  /** Update bounds on viewport resize (windows re-clamped). */
  setBounds(bounds: WindowBounds): void {
    this.bounds = bounds;
    this.windows = this.windows.map((w) => ({
      ...w,
      x: clamp(w.x, 0, Math.max(0, bounds.width - 60)),
      y: clamp(w.y, 0, Math.max(0, bounds.height - 24)),
      width: clamp(w.width, MIN_WINDOW_W, bounds.width),
      height: clamp(w.height, MIN_WINDOW_H, bounds.height),
    }));
    this.changed();
  }
}

function clamp(v: number, lo: number, hi: number): number {
  if (hi < lo) return lo;
  return Math.min(Math.max(v, lo), hi);
}
