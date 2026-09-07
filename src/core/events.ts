/**
 * §3 typed EventBus + Foundry-style Hooks signatures. Lower layers never
 * import from higher layers; both buses are provided by the core layer.
 */

export type Unsubscribe = () => void;

/** Typed in-process event bus. */
export interface EventBus<TEvents extends object> {
  on<K extends keyof TEvents & string>(type: K, cb: (payload: TEvents[K]) => void): Unsubscribe;
  once<K extends keyof TEvents & string>(type: K, cb: (payload: TEvents[K]) => void): Unsubscribe;
  emit<K extends keyof TEvents & string>(type: K, payload: TEvents[K]): void;
}

/** Foundry-style hook callback (args vary per hook name). */
export type HookCallback = (...args: unknown[]) => unknown;

/** §3: Hooks.on / Hooks.call / Hooks.callAll / Hooks.once / Hooks.off. */
export interface HooksApi {
  on(name: string, cb: HookCallback): number;
  once(name: string, cb: HookCallback): number;
  off(name: string, id: number): void;
  /** Run hooks, stop on first `false` return, collect results. */
  call(name: string, ...args: unknown[]): unknown[];
  callAll(name: string, ...args: unknown[]): void;
}

// ─── Implementations ──────────────────────────────────────────────────────────

/** Typed in-process EventBus implementation (§3). */
export function createEventBus<TEvents extends object>(): EventBus<TEvents> {
  const handlers = new Map<string, Set<(payload: unknown) => void>>();
  return {
    on(type, cb) {
      let set = handlers.get(type);
      if (!set) {
        set = new Set();
        handlers.set(type, set);
      }
      const wrapped = cb as (payload: unknown) => void;
      set.add(wrapped);
      return () => set.delete(wrapped);
    },
    once(type, cb) {
      let off: Unsubscribe = () => {};
      off = this.on(type, (payload) => {
        off();
        (cb as (payload: unknown) => void)(payload);
      });
      return off;
    },
    emit(type, payload) {
      const set = handlers.get(type);
      if (!set) return;
      // Snapshot: callbacks may unsubscribe (incl. themselves) during dispatch.
      for (const cb of [...set]) cb(payload);
    },
  };
}

interface HookEntry {
  id: number;
  cb: HookCallback;
}

/** Foundry-style Hooks implementation (§3). Fresh instances per game/session. */
export function createHooks(): HooksApi {
  const registry = new Map<string, HookEntry[]>();
  let nextId = 1;

  const remove = (name: string, id: number): void => {
    const entries = registry.get(name);
    if (!entries) return;
    registry.set(
      name,
      entries.filter((e) => e.id !== id),
    );
  };

  return {
    on(name, cb) {
      const id = nextId++;
      const entries = registry.get(name) ?? [];
      entries.push({ id, cb });
      registry.set(name, entries);
      return id;
    },
    once(name, cb) {
      let id = 0;
      const wrapped: HookCallback = (...args) => {
        if (id !== 0) remove(name, id);
        id = 0;
        return cb(...args);
      };
      id = this.on(name, wrapped);
      return id;
    },
    off(name, id) {
      remove(name, id);
    },
    call(name, ...args) {
      const entries = [...(registry.get(name) ?? [])];
      const results: unknown[] = [];
      for (const entry of entries) {
        const result = entry.cb(...args);
        results.push(result);
        if (result === false) break;
      }
      return results;
    },
    callAll(name, ...args) {
      for (const entry of [...(registry.get(name) ?? [])]) entry.cb(...args);
    },
  };
}

/** Process-wide Hooks instance (the `Hooks.on("updateToken", cb)` of §3). */
export const globalHooks: HooksApi = createHooks();
