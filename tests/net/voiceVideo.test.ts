import { describe, expect, test } from "vitest";
import { VoiceVideoMesh } from "../../src/net/voiceVideo";

describe("§1 Voice/video mesh (<= 6 peers)", () => {
  test("initializes with audio/video disabled by default", () => {
    const mesh = new VoiceVideoMesh({ selfId: "p1" });
    expect(mesh.isAudioMuted()).toBe(true);
    expect(mesh.isVideoMuted()).toBe(true);
    expect(mesh.getPeers().length).toBe(0);
  });

  test("tracks connected peers up to the cap of 6", () => {
    const mesh = new VoiceVideoMesh({ selfId: "p1", maxPeers: 6 });
    for (let i = 2; i <= 8; i++) {
      mesh.addPeer(`p${i}`);
    }
    // Capped at 6 peers
    expect(mesh.getPeers().length).toBe(6);
    expect(mesh.getPeers()).toEqual(["p2", "p3", "p4", "p5", "p6", "p7"]);
  });

  test("toggle mute state triggers event listeners", () => {
    const mesh = new VoiceVideoMesh({ selfId: "p1" });
    let audioState = false;
    let videoState = false;

    mesh.onAudioMuteChange = (muted) => {
      audioState = muted;
    };
    mesh.onVideoMuteChange = (muted) => {
      videoState = muted;
    };

    mesh.setAudioMuted(false);
    expect(audioState).toBe(false);
    expect(mesh.isAudioMuted()).toBe(false);

    mesh.setVideoMuted(false);
    expect(videoState).toBe(false);
    expect(mesh.isVideoMuted()).toBe(false);
  });

  test("per-peer volume control clamps between 0 and 1", () => {
    const mesh = new VoiceVideoMesh({ selfId: "p1" });
    mesh.addPeer("p2");

    mesh.setPeerVolume("p2", 0.75);
    expect(mesh.getPeerVolume("p2")).toBe(0.75);

    mesh.setPeerVolume("p2", 1.5);
    expect(mesh.getPeerVolume("p2")).toBe(1.0);

    mesh.setPeerVolume("p2", -0.5);
    expect(mesh.getPeerVolume("p2")).toBe(0.0);
  });
});
