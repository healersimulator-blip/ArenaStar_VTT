import { describe, expect, test, vi } from "vitest";
import { createEventBus, createHooks } from "../../src/core/events";

describe("createEventBus (§3)", () => {
  test("on/emit delivers typed payloads", () => {
    const bus = createEventBus<{ ping: number; msg: string }>();
    const spy = vi.fn();
    bus.on("ping", spy);
    bus.emit("ping", 42);
    expect(spy).toHaveBeenCalledWith(42);
  });

  test("once fires exactly one time", () => {
    const bus = createEventBus<{ e: number }>();
    const spy = vi.fn();
    bus.once("e", spy);
    bus.emit("e", 1);
    bus.emit("e", 2);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  test("unsubscribing during dispatch is safe", () => {
    const bus = createEventBus<{ e: number }>();
    const a = vi.fn(() => off());
    const b = vi.fn();
    const off = bus.on("e", a);
    bus.on("e", b);
    bus.emit("e", 1);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    bus.emit("e", 2);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(2);
  });

  test("emit with no listeners is a no-op", () => {
    const bus = createEventBus<{ e: never }>();
    expect(() => bus.emit("e", undefined as never)).not.toThrow();
  });
});

describe("createHooks — Foundry-style (§3)", () => {
  test("on returns increasing ids; call fires in order and collects results", () => {
    const hooks = createHooks();
    const order: string[] = [];
    const id1 = hooks.on("updateToken", () => {
      order.push("first");
      return 1;
    });
    hooks.on("updateToken", () => {
      order.push("second");
      return 2;
    });
    const results = hooks.call("updateToken", { id: "t1" });
    expect(id1).toBeGreaterThan(0);
    expect(order).toEqual(["first", "second"]);
    expect(results).toEqual([1, 2]);
  });

  test("call stops at the first `false` return", () => {
    const hooks = createHooks();
    const second = vi.fn();
    hooks.on("gate", () => false);
    hooks.on("gate", second);
    const results = hooks.call("gate");
    expect(second).not.toHaveBeenCalled();
    expect(results).toEqual([false]);
  });

  test("callAll fires every hook regardless of returns", () => {
    const hooks = createHooks();
    const second = vi.fn();
    hooks.on("gate", () => false);
    hooks.on("gate", second);
    hooks.callAll("gate");
    expect(second).toHaveBeenCalledTimes(1);
  });

  test("once unregisters after the first call", () => {
    const hooks = createHooks();
    const spy = vi.fn();
    hooks.once("init", spy);
    hooks.callAll("init");
    hooks.callAll("init");
    expect(spy).toHaveBeenCalledTimes(1);
  });

  test("off removes exactly the registered id", () => {
    const hooks = createHooks();
    const spy = vi.fn();
    const id = hooks.on("x", spy);
    hooks.off("x", id);
    hooks.off("x", 99999); // unknown id is a no-op
    hooks.callAll("x");
    expect(spy).not.toHaveBeenCalled();
  });

  test("hook names are independent", () => {
    const hooks = createHooks();
    const a = vi.fn();
    const b = vi.fn();
    hooks.on("alpha", a);
    hooks.on("beta", b);
    hooks.callAll("alpha");
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).not.toHaveBeenCalled();
  });
});
