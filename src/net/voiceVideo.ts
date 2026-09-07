/**
 * §1 Voice & Video Mesh (≤ 6 peers)
 *
 * Manages peer media state (audio/video mute toggles, per-peer volumes) and
 * track integration for WebRTC sessions.
 */

export interface VoiceVideoOptions {
  selfId: string;
  maxPeers?: number; // default 6 per §1
}

export class VoiceVideoMesh {
  public readonly selfId: string;
  private readonly maxPeers: number;
  private readonly peers = new Map<string, { volume: number }>();
  private audioMuted = true;
  private videoMuted = true;

  onAudioMuteChange: ((muted: boolean) => void) | null = null;
  onVideoMuteChange: ((muted: boolean) => void) | null = null;
  onPeerVolumeChange: ((peerId: string, volume: number) => void) | null = null;

  constructor(options: VoiceVideoOptions) {
    this.selfId = options.selfId;
    this.maxPeers = options.maxPeers ?? 6;
  }

  addPeer(peerId: string): boolean {
    if (this.peers.has(peerId)) return true;
    if (this.peers.size >= this.maxPeers) return false;
    this.peers.set(peerId, { volume: 1.0 });
    return true;
  }

  removePeer(peerId: string): void {
    this.peers.delete(peerId);
  }

  getPeers(): string[] {
    return Array.from(this.peers.keys());
  }

  isAudioMuted(): boolean {
    return this.audioMuted;
  }

  setAudioMuted(muted: boolean): void {
    if (this.audioMuted === muted) return;
    this.audioMuted = muted;
    this.onAudioMuteChange?.(muted);
  }

  isVideoMuted(): boolean {
    return this.videoMuted;
  }

  setVideoMuted(muted: boolean): void {
    if (this.videoMuted === muted) return;
    this.videoMuted = muted;
    this.onVideoMuteChange?.(muted);
  }

  getPeerVolume(peerId: string): number {
    return this.peers.get(peerId)?.volume ?? 1.0;
  }

  setPeerVolume(peerId: string, volume: number): void {
    const clamped = Math.max(0, Math.min(1, volume));
    const peer = this.peers.get(peerId);
    if (peer) {
      peer.volume = clamped;
      this.onPeerVolumeChange?.(peerId, clamped);
    }
  }
}
