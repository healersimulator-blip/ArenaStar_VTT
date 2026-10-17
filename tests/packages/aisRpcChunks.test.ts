import vm from "node:vm";
import { describe, expect, test, vi } from "vitest";
import {
  AisRequestAssembler,
  aisRequestChunks,
  AIS_DOCUMENT_REQUEST_BYTES,
} from "../../src/packages/aisRpcChunks";
import {
  AIS_MAX_RPC_BYTES,
  AIS_MODULE_METHODS,
  createAisModuleDispatcher,
  type AisModuleHandlers,
  type AisModuleResponse,
} from "../../src/packages/aisModuleIframe";
import { aisModuleRuntimeSource } from "../../src/packages/aisModuleRuntimeSource";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const bytes = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value)).length;
const handlers = () =>
  Object.fromEntries(
    AIS_MODULE_METHODS.map((method) => [
      method,
      vi.fn(async () => ({ ok: true })),
    ]),
  ) as unknown as AisModuleHandlers;
const request = (
  id = 1,
  method = "documents.mutate",
  args: unknown = { ops: [{ data: '😀\u0000"\\'.repeat(12000) }] },
) => ({ vttAisRpc: 1, kind: "request", id, method, args });

/** Executes the actual injected SDK in its own realm, with JSON copying across the port. */
function sdk(calls: AisModuleHandlers) {
  const frames: unknown[] = [];
  const replies: AisModuleResponse[] = [];
  const dispatcher = createAisModuleDispatcher(
    calls,
    new Set(["documents.read", "documents.write", "chat.post", "compendium.read"]),
    vi.fn(),
  );
  const context = vm.createContext({
    TextEncoder,
    setTimeout,
    clearTimeout,
    console,
    window: { addEventListener: () => undefined },
    parent: { postMessage: () => undefined },
    sendToHost: (data: unknown) => {
      frames.push(data);
      dispatcher.onFrame(
        JSON.parse(JSON.stringify(data)) as unknown,
        (response) => {
          replies.push(response);
          vm.runInContext(
            `guestPort.onmessage({ data: ${JSON.stringify(response)} })`,
            context,
          );
        },
      );
    },
  });
  vm.runInContext(
    `class MessageChannel { constructor() {
    globalThis.guestPort = this.port1 = { postMessage: (data) => sendToHost(data), start() {}, close() {} };
    this.port2 = {};
  } }`,
    context,
  );
  vm.runInContext(aisModuleRuntimeSource("test"), context);
  return {
    frames,
    replies,
    run: (source: string) =>
      vm.runInContext(source, context) as Promise<unknown>,
  };
}

describe("document RPC chunk transport", () => {
  test("the actual SDK and dispatcher preserve escaped/unicode/deep documents across writes and reads", async () => {
    const calls = handlers();
    const doc = {
      name: "Mage",
      description: '😀\u0000"\\'.repeat(12000),
      system: {
        nested: Array.from({ length: 16 }).reduce<unknown>(
          (value) => ({ value }),
          "leaf",
        ),
      },
    };
    calls["documents.mutate"] = vi.fn(async (args) => {
      expect(args).toEqual({ ops: [{ kind: "create", data: doc }] });
      return { txId: "tx" };
    });
    calls["documents.get"] = vi.fn(async () => ({ document: doc }));
    calls["compendium.get"] = vi.fn(async () => ({ data: doc }));
    const guest = sdk(calls);
    await expect(
      guest.run(
        `AIS.documents.mutate([{kind: "create", data: ${JSON.stringify(doc)}}])`,
      ),
    ).resolves.toEqual({ txId: "tx" });
    await expect(
      guest.run(`AIS.documents.get({collection: "actors", id: "mage"})`),
    ).resolves.toEqual(doc);
    await expect(guest.run(`AIS.compendium.get("content/actors.db", "mage")`)).resolves.toEqual({ data: doc });
    expect(guest.frames.length).toBeGreaterThan(2);
    expect(guest.replies.some((frame) => frame.kind === "response-chunk")).toBe(
      true,
    );
    for (const frame of [...guest.frames, ...guest.replies])
      expect(bytes(frame)).toBeLessThanOrEqual(AIS_MAX_RPC_BYTES);
    expect(calls["documents.mutate"]).toHaveBeenCalledTimes(1);
  });

  test("ordinary SDK requests and over-budget document writes are still refused", async () => {
    const guest = sdk(handlers());
    await expect(guest.run(`AIS.chat.post("x".repeat(70000))`)).rejects.toThrow(
      "budget",
    );
    await expect(
      guest.run(`AIS.documents.mutate([{data: "x".repeat(530000)}])`),
    ).rejects.toThrow("budget");
    await expect(
      guest.run(
        `AIS.documents.mutate([{data: (() => { let v = {}; for (let i=0;i<40;i++) v={v}; return v; })()}])`,
      ),
    ).rejects.toThrow("bounded JSON");
    expect(guest.frames).toEqual([]);
  });

  test.each([
    "missing",
    "duplicate",
    "expired",
    "id",
    "malformed",
    "oversized",
  ])("%s chunks never execute a partial transaction", async (mode) => {
    const calls = handlers();
    const dispatcher = createAisModuleDispatcher(
      calls,
      new Set(["documents.write"]),
      vi.fn(),
    );
    const frame = request();
    const chunks = aisRequestChunks(frame, 1);
    const post = vi.fn();
    const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
    try {
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        if (!chunk) throw new Error("missing test chunk");
        if (mode === "missing" && i === 1) continue;
        if (mode === "expired" && i === 1) clock.mockReturnValue(31001);
        if (mode === "id" && i === 1)
          dispatcher.onFrame({ ...chunk, id: 2 }, post);
        else if (mode === "malformed" && i === 1)
          dispatcher.onFrame({ ...chunk, text: null }, post);
        else if (mode === "oversized" && i === 1)
          dispatcher.onFrame({ ...chunk, text: "x".repeat(70000) }, post);
        else dispatcher.onFrame(chunk, post);
        if (mode === "duplicate" && i === 1) dispatcher.onFrame(chunk, post);
      }
      await tick();
      expect(calls["documents.mutate"]).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
    }
  });

  test("replays, a missing grant, inactive commands and chunked non-document methods cannot write", async () => {
    const calls = handlers();
    const dispatcher = createAisModuleDispatcher(
      calls,
      new Set(["documents.write"]),
      vi.fn(),
    );
    const post = vi.fn();
    const chunks = aisRequestChunks(request(), 1);
    for (const chunk of [...chunks, ...chunks]) dispatcher.onFrame(chunk, post);
    await tick();
    expect(calls["documents.mutate"]).toHaveBeenCalledTimes(1);
    for (const chunk of aisRequestChunks(
      { ...request(2), commandId: "cmd-1" },
      2,
    ))
      dispatcher.onFrame(chunk, post, () => null);
    for (const chunk of aisRequestChunks(request(3, "chat.post"), 3))
      dispatcher.onFrame(chunk, post);
    const denied = createAisModuleDispatcher(calls, new Set(), vi.fn());
    for (const chunk of aisRequestChunks(request(4), 4))
      denied.onFrame(chunk, post);
    await tick();
    expect(calls["documents.mutate"]).toHaveBeenCalledTimes(1);
    expect(calls["chat.post"]).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: false,
        error: "AIS macro command is no longer active",
      }),
    );
  });

  test("assembly enforces its total budget, resets, and refuses malformed JSON", () => {
    const assembler = new AisRequestAssembler();
    for (const chunk of aisRequestChunks(
      request(1, "documents.mutate", {
        data: "x".repeat(AIS_DOCUMENT_REQUEST_BYTES + 1),
      }),
      1,
    ))
      expect(assembler.accept({ ...chunk }, 0)).toBeNull();
    expect(
      assembler.accept(
        {
          vttAisRpc: 1,
          kind: "request-chunk",
          id: 2,
          index: 0,
          total: 1,
          text: "{",
        },
        0,
      ),
    ).toBeNull();
    const small = request(3, "documents.mutate", {});
    expect(assembler.accept({ ...aisRequestChunks(small, 3)[0] }, 0)).toEqual({
      id: 3,
      value: small,
    });
  });
});
