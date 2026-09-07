import { describe, expect, it, vi } from "vitest";
import type { TurnReport } from "../../src/core/sim";
import { TurnReportPlayback } from "../../src/ui/armies/turnReportPlayback";

function makeSampleReport(): TurnReport {
  return {
    turn: 1,
    sceneId: "scene-1",
    subPhases: ["move", "shoot", "melee"],
    events: [
      { subPhase: "move", type: "arrive", unitId: "u1", at: { x: 100, y: 100 }, text: "Unit 1 arrived" },
      { subPhase: "shoot", type: "attack", unitId: "u1", targetUnitId: "u2", text: "Unit 1 fired at Unit 2" },
      { subPhase: "melee", type: "casualty", unitId: "u2", text: "Unit 2 took 3 casualties" },
    ],
    summary: {},
    rulesVersion: "1.0.0",
  };
}

describe("TurnReportPlayback (§9A)", () => {
  it("initializes with first event", () => {
    const report = makeSampleReport();
    const playback = new TurnReportPlayback(report);
    const state = playback.getState();

    expect(state.eventIndex).toBe(0);
    expect(state.playing).toBe(false);
    expect(state.completed).toBe(false);
    expect(state.currentSubPhase).toBe("move");
    expect(state.activeEvent?.text).toBe("Unit 1 arrived");
  });

  it("handles seek and step operations", () => {
    const report = makeSampleReport();
    const playback = new TurnReportPlayback(report);

    playback.stepForward();
    expect(playback.getState().eventIndex).toBe(1);
    expect(playback.getState().currentSubPhase).toBe("shoot");

    playback.stepForward();
    expect(playback.getState().eventIndex).toBe(2);
    expect(playback.getState().currentSubPhase).toBe("melee");
    expect(playback.getState().completed).toBe(true);

    playback.stepBack();
    expect(playback.getState().eventIndex).toBe(1);

    playback.seek(0);
    expect(playback.getState().eventIndex).toBe(0);

    playback.seekProgress(1.0);
    expect(playback.getState().eventIndex).toBe(2);
  });

  it("executes GM skip to jump to the end instantly", () => {
    const report = makeSampleReport();
    const playback = new TurnReportPlayback(report);

    playback.play();
    expect(playback.getState().playing).toBe(true);

    playback.skip();
    const state = playback.getState();
    expect(state.playing).toBe(false);
    expect(state.eventIndex).toBe(2);
    expect(state.completed).toBe(true);
  });

  it("ticks playback over time", () => {
    const report = makeSampleReport();
    const playback = new TurnReportPlayback(report);

    playback.play();
    playback.setSpeed(2); // 2x speed -> interval 400ms

    const updated = playback.tick(450); // > 400ms -> advances step
    expect(updated).toBe(true);
    expect(playback.getState().eventIndex).toBe(1);
  });

  it("notifies state change listener", () => {
    const report = makeSampleReport();
    const listener = vi.fn();
    const playback = new TurnReportPlayback(report, listener);

    playback.stepForward();
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ eventIndex: 1 }));
  });
});
