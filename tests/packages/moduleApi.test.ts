import { describe, expect, test } from "vitest";
import {
  createModuleDispatcher,
  MODULE_METHODS,
  parseModuleFrame,
  type ModuleFrameToModule,
  type ModuleHandlers,
  type ModuleRpcResponse,
} from "../../src/core/moduleApi";

const handlers: ModuleHandlers = {
  "game.info": () => ({ world: "w1" }),
  "settings.get": () => null,
  "settings.set": () => ({ ok: true }),
  "tokens.list": () => ({ tokens: [] }),
  "tokens.move": (args) => {
    if (args.id === "bad") throw new Error("unknown token bad");
    return { ok: true };
  },
  "chat.create": () => ({ id: "msg-1" }),
  notify: () => ({ ok: true }),
  "hooks.subscribe": () => ({ ok: true }),
};

const dispatch = (data: unknown): Promise<ModuleFrameToModule | null> =>
  new Promise((resolve) => {
    let out: ModuleFrameToModule | null = null;
    const d = createModuleDispatcher(handlers);
    d.onFrame(data, (frame) => {
      out = frame;
    });
    setTimeout(() => resolve(out), 10);
  });

const request = (id: number, method: string, args?: unknown): unknown => ({
  vttModuleRpc: 1,
  kind: "request",
  id,
  method,
  args: args === undefined ? null : args,
});

describe("parseModuleFrame (§12)", () => {
  test("accepts whitelisted requests, rejects everything else", () => {
    expect(parseModuleFrame(request(1, "game.info")).ok).toBe(true);
    expect(parseModuleFrame(request(1, "evil.method")).ok).toBe(false);
    expect(parseModuleFrame({ vttModuleRpc: 1, kind: "response", id: 1, ok: true }).ok).toBe(false);
    expect(parseModuleFrame({ kind: "request", id: 1, method: "game.info" }).ok).toBe(false);
    expect(parseModuleFrame(request(-1, "game.info")).ok).toBe(false);
    expect(parseModuleFrame(request(1.5, "game.info")).ok).toBe(false);
    expect(parseModuleFrame(request(1, "game.info", { big: "x".repeat(80_000) })).ok).toBe(false);
    expect(MODULE_METHODS).toContain("chat.create");
  });
});

describe("createModuleDispatcher (§12)", () => {
  test("routes requests to handlers and answers with results", async () => {
    const res = (await dispatch(request(7, "game.info"))) as ModuleRpcResponse;
    expect(res.kind).toBe("response");
    expect(res.id).toBe(7);
    expect(res.ok).toBe(true);
    expect(res.result).toEqual({ world: "w1" });
  });

  test("handler throws become error responses, never rejections", async () => {
    const res = (await dispatch(request(8, "tokens.move", { id: "bad" }))) as ModuleRpcResponse;
    expect(res.ok).toBe(false);
    expect(res.error).toContain("unknown token bad");
  });

  test("malformed frames are dropped silently (no response)", async () => {
    expect(await dispatch({ hello: 1 })).toBeNull();
    expect(await dispatch(request(2, "nope"))).toBeNull();
  });

  test("async handlers are awaited", async () => {
    const d = createModuleDispatcher({
      ...handlers,
      "settings.get": async () => {
        await new Promise((r) => setTimeout(r, 5));
        return 42;
      },
    });
    const out = await new Promise<ModuleRpcResponse>((resolve) => {
      d.onFrame(request(3, "settings.get"), (frame) => resolve(frame as ModuleRpcResponse));
    });
    expect(out.result).toBe(42);
  });
});
