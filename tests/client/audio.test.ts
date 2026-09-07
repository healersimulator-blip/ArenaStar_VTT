import { describe, expect, test } from "vitest";
import {
  estimateClockOffset,
  hostTimeFromClient,
  nextPlaylistSound,
  parsePlaylistMode,
  scheduleDelayMs,
  type ClockSample,
} from "../../src/core/audio";
import { HostSync, gmSessionUser, type HostEvents } from "../../src/host/sync";
import { ClientSync, type ClientEvents } from "../../src/client/sync";
import { createTransportPair, flushMicrotasks } from "../../src/net/memory";
import { createEventBus, type EventBus } from "../../src/core/events";
import { DocumentStore, OpLog, UndoStack, type StoreMeta } from "../../src/core";
import type { AudioCmdMsg } from "../../src/core/messages";

const meta: StoreMeta = {
  worldId: "w-audio",
  name: "Audio",
  system: "mass-battle-basic",
  systemVersion: "1.0.0",
};

function sample(t0: number, t1: number, t2: number, t3: number): ClockSample {
  return { t0, t1, t2, t3 };
}

describe("NTP-style clock math (§7)", () => {
  test("perfect symmetric link → offset recovered exactly", () => {
    // host = client + 100 ms; 6 ms up, 6 ms host processing, 6 ms down
    const s = sample(1000, 1106, 1112, 1018);
    const e = estimateClockOffset([s]);
    expect(e).not.toBeNull();
    expect(e?.offsetMs).toBeCloseTo(100, 6);
    expect(e?.rttMs).toBe(18); // 6 up + 6 processing + 6 down
  });

  test("lowest-RTT sample wins", () => {
    const noisy = sample(0, 80, 82, 200); // rtt 200, skewed
    const good = sample(1000, 1011, 1013, 1025); // rtt 25
    const e = estimateClockOffset([noisy, good]);
    expect(e?.rttMs).toBe(25);
  });

  test("no samples → null", () => {
    expect(estimateClockOffset([])).toBeNull();
  });

  test("hostTimeFromClient and scheduleDelayMs are inverses", () => {
    const offset = 250; // host ahead
    const clientNow = 10_000;
    const atHost = hostTimeFromClient(clientNow + 30, offset); // fire in 30 ms
    expect(scheduleDelayMs(clientNow, offset, atHost)).toBeCloseTo(30, 6);
    // past moments clamp at the caller (negative → start immediately)
    expect(
      scheduleDelayMs(clientNow, offset, hostTimeFromClient(clientNow - 5, offset)),
    ).toBeLessThan(0);
  });
});

describe("playlist advance (§7/D-078)", () => {
  const sounds = [{ _id: "a" }, { _id: "b" }, { _id: "c" }];

  test("off never advances", () => {
    expect(nextPlaylistSound(sounds, "a", "off")).toBeNull();
  });

  test("sequential walks and stops at the end", () => {
    expect(nextPlaylistSound(sounds, null, "sequential")).toBe("a");
    expect(nextPlaylistSound(sounds, "a", "sequential")).toBe("b");
    expect(nextPlaylistSound(sounds, "c", "sequential")).toBeNull();
  });

  test("loop wraps", () => {
    expect(nextPlaylistSound(sounds, "c", "loop")).toBe("a");
  });

  test("shuffle picks another sound", () => {
    let calls = 0;
    const rand = () => {
      calls++;
      return 0; // always index 0 ("a")
    };
    expect(nextPlaylistSound(sounds, "b", "shuffle", rand)).toBe("a");
    // current is already "a" → guard falls through to idx+1
    expect(nextPlaylistSound(sounds, "a", "shuffle", rand)).toBe("b");
    expect(calls).toBeGreaterThanOrEqual(1);
  });

  test("parsePlaylistMode falls back to off", () => {
    expect(parsePlaylistMode("loop")).toBe("loop");
    expect(parsePlaylistMode("weird")).toBe("off");
  });
});

describe("clock + audio over the wire (§7)", () => {
  async function boot(): Promise<{
    gm: ClientSync;
    gmBus: EventBus<ClientEvents>;
    host: HostSync;
  }> {
    const host = new HostSync({
      store: new DocumentStore({ meta }),
      log: new OpLog(),
      undo: new UndoStack(),
      bus: createEventBus<HostEvents>(),
      systemUserId: "gm",
      roomId: "r",
      verifyHelloSig: async () => true,
    });
    const pair = createTransportPair();
    host.addSession("gm", pair.a, gmSessionUser("gm"));
    const gmBus = createEventBus<ClientEvents>();
    const gm = new ClientSync({ transport: pair.b, bus: gmBus, meta });
    await flushMicrotasks();
    return { gm, gmBus, host };
  }

  test("ping → pong builds a usable offset estimate", async () => {
    const { gm } = await boot();
    expect(gm.clockOffset()).toBeNull(); // before any probe
    gm.sendPing();
    await flushMicrotasks();
    const estimate = gm.clockOffset();
    expect(estimate).not.toBeNull();
    expect(Math.abs(estimate?.offsetMs ?? 9999)).toBeLessThan(2000); // same process
    expect(estimate?.rttMs ?? 9999).toBeLessThan(2000);
  });

  test("audio.cmd: host stamps atHostTime (+lead) and rebroadcasts to GM", async () => {
    const { gm, gmBus } = await boot();
    const received: AudioCmdMsg[] = [];
    const off = gmBus.on("audio", (m) => received.push(m));
    const before = Date.now();
    gm.sendAudioCmd({ playlistId: "pl", soundId: "s", action: "play", offset: 0 });
    await flushMicrotasks();
    off();
    expect(received).toHaveLength(1);
    const cmd = received[0];
    expect(cmd?.soundId).toBe("s");
    expect(cmd?.atHostTime).toBeDefined();
    // scheduled ~120 ms ahead of the host clock at request time
    expect(cmd?.atHostTime ?? 0).toBeGreaterThanOrEqual(before);
    expect(cmd?.atHostTime ?? 0).toBeLessThanOrEqual(before + HostSync.AUDIO_LEAD_MS + 2000);
  });
});
