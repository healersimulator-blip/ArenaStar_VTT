import {
  CloudCompanion,
  GitHubBackups,
  type CompanionStatus,
} from "./companion";
import {
  loadCloudPreferences,
  saveCloudPreferences,
  validateBackupLimit,
  assertBackupSize,
  type CloudPreferences,
} from "./preferences";
import { GoogleDriveAuth } from "./googleAuth";
import {
  DriveError,
  GoogleDriveBackups,
  sha256,
  type BackupJob,
  type DriveBackup,
} from "./googleDrive";

type Phase =
  | "idle"
  | "setup"
  | "sign-in"
  | "preparing"
  | "uploading"
  | "verifying"
  | "listing"
  | "downloading";
export interface CloudBackupState {
  preferences: CloudPreferences;
  companion: CompanionStatus | null;
  ready: boolean;
  connected: boolean;
  phase: Phase;
  error: string | null;
  notice: string;
  progress: number;
  canRetry: boolean;
  backups: readonly DriveBackup[];
  folderUrl: string | null;
  lastVerifiedAt: number | null;
}
interface BackupSource {
  worldId: string;
  worldName: string;
  archive: () => Promise<Blob>;
}
const initial = (): CloudBackupState => ({
  preferences: loadCloudPreferences(),
  companion: null,
  ready: false,
  connected: false,
  phase: "idle",
  error: null,
  notice: "",
  progress: 0,
  canRetry: false,
  backups: [],
  folderUrl: null,
  lastVerifiedAt: null,
});

/** One GM-local controller shared by both settings surfaces. Tokens/jobs never enter world documents. */
export class CloudBackupController {
  private value = initial();
  private readonly listeners = new Set<(value: CloudBackupState) => void>();
  private operation: AbortController | null = null;
  private provider: GoogleDriveBackups | GitHubBackups | null = null;
  private job: BackupJob | null = null;
  private disposed = false;
  private readonly companion = new CloudCompanion();
  private maxBytes = () => this.value.preferences.maxMiB * 1048576;
  constructor(
    private readonly source: BackupSource,
    private readonly auth = new GoogleDriveAuth(),
  ) {}
  get state(): CloudBackupState {
    return {
      ...this.value,
      connected:
        this.value.preferences.mode === "temporary" &&
        this.value.preferences.destination === "google"
          ? this.auth.connected
          : this.value.connected,
      canRetry: this.job !== null,
    };
  }
  subscribe(listener: (state: CloudBackupState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private update(patch: Partial<CloudBackupState>): void {
    this.value = { ...this.value, ...patch };
    for (const listener of this.listeners) {
      try {
        listener(this.state);
      } catch {
        /* UI observer */
      }
    }
  }
  private run<T>(
    phase: Phase,
    job: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (this.disposed)
      return Promise.reject(new Error("This world is closed."));
    if (this.operation)
      return Promise.reject(new Error("A cloud operation is already running."));
    const controller = new AbortController();
    this.operation = controller;
    this.update({ phase, error: null, notice: "", progress: 0 });
    const timeout = setTimeout(
      () =>
        controller.abort(
          new Error(
            "Cloud operation timed out. Retry when the connection is available.",
          ),
        ),
      30 * 60_000,
    );
    return (async () => {
      try {
        return await job(controller.signal);
      } catch (error) {
        if (
          this.operation === controller &&
          error instanceof DriveError &&
          error.status === 401
        ) {
          this.auth.clear();
          this.update({ connected: false });
        }
        if (this.operation === controller)
          this.update({
            error: controller.signal.aborted
              ? "Cloud operation cancelled or timed out. Local saving is unaffected; an unfinished file or draft release may remain."
              : error instanceof Error
                ? error.message
                : "Cloud operation failed. Local saving is unaffected.",
          });
        throw error;
      } finally {
        clearTimeout(timeout);
        if (this.operation === controller) {
          this.operation = null;
          this.update({ phase: "idle" });
        }
      }
    })();
  }
  prepare(clientId: string): Promise<void> {
    this.configure({
      ...this.value.preferences,
      destination: "google",
      mode: "temporary",
    });
    return this.run("setup", async (signal) => {
      await this.auth.prepare(clientId.trim());
      signal.throwIfAborted();
      this.update({ ready: true });
    });
  }
  connect(): Promise<void> {
    return this.run("sign-in", async (signal) => {
      if (
        this.value.preferences.mode === "remembered" ||
        this.value.preferences.destination === "github"
      ) {
        if (this.value.preferences.destination === "google")
          await this.companion.connectGoogle(signal);
        await this.restoreProvider(signal);
        this.update({
          notice: "Connection remembered. No world has been uploaded.",
        });
        return;
      }
      // connect() opens the already-prepared GIS popup synchronously on the user's click.
      await this.auth.connect();
      signal.throwIfAborted();
      this.job = null;
      this.provider = new GoogleDriveBackups(
        () => this.auth.token(),
        fetch,
        this.maxBytes,
      );
      this.update({ backups: [], lastVerifiedAt: null });
      const backups = await this.provider.list(signal);
      signal.throwIfAborted();
      this.update({
        backups,
        folderUrl: this.provider.folderUrl,
        notice: "Connected for this session. No world has been uploaded.",
      });
    });
  }
  configure(preferences: CloudPreferences): void {
    if (this.operation) return;
    try {
      validateBackupLimit(preferences.maxMiB);
    } catch (error) {
      this.update({
        error: error instanceof Error ? error.message : "Invalid size limit.",
      });
      return;
    }
    const changed =
      preferences.destination !== this.value.preferences.destination ||
      preferences.mode !== this.value.preferences.mode ||
      preferences.repository !== this.value.preferences.repository;
    if (changed) this.disconnect();
    saveCloudPreferences(preferences);
    this.update({ preferences: { ...preferences }, error: null });
  }
  /** Quiet startup probe. Missing/offline companion never interrupts local play. */
  async restore(): Promise<void> {
    if (
      this.operation ||
      this.disposed ||
      (this.value.preferences.mode === "temporary" &&
        this.value.preferences.destination === "google")
    )
      return;
    try {
      await this.run("setup", (signal) => this.restoreProvider(signal));
    } catch {
      if (!this.disposed)
        this.update({
          error: null,
          notice:
            "Remembered backups need the companion running. Local saves are unaffected.",
        });
    }
  }
  private async restoreProvider(signal: AbortSignal): Promise<void> {
    this.provider = null;
    this.update({ connected: false });
    const status = await this.companion.status(signal);
    signal.throwIfAborted();
    const github = this.value.preferences.destination === "github";
    this.update({
      companion: status,
      ready:
        status.paired &&
        (github ? status.githubConfigured : status.googleConfigured),
    });
    if (!status.paired) return;
    let provider: GoogleDriveBackups | GitHubBackups;
    if (github) {
      if (!status.githubConfigured || !this.value.preferences.repository)
        return;
      const git = new GitHubBackups(
        this.companion,
        this.value.preferences.repository.trim(),
        this.maxBytes,
      );
      await git.connect(signal);
      provider = git;
    } else {
      if (!status.googleConnected) return;
      provider = new GoogleDriveBackups(
        () => this.companion.token(),
        fetch,
        this.maxBytes,
      );
    }
    const backups = await provider.list(signal);
    signal.throwIfAborted();
    this.provider = provider;
    this.update({ connected: true, backups, folderUrl: provider.folderUrl });
  }
  pair(key: string): Promise<void> {
    return this.run("setup", async (signal) => {
      await this.companion.pair(key, signal);
      await this.restoreProvider(signal);
    });
  }
  forgetBrowser(): Promise<void> {
    return this.run("setup", async (signal) => {
      await this.companion.request("unpair", {}, signal);
      this.provider = null;
      this.job = null;
      this.auth.clear();
      this.update({
        connected: false,
        companion: null,
        backups: [],
        folderUrl: null,
        ready: false,
        notice:
          "This browser was forgotten. Existing backups and the companion’s saved accounts were not changed.",
      });
    });
  }
  forgetGoogle(): Promise<void> {
    return this.run("setup", async (signal) => {
      const result = await this.companion.request<{ revoked: boolean }>(
        "google/forget",
        {},
        signal,
      );
      this.provider = null;
      this.job = null;
      this.update({
        connected: false,
        backups: [],
        folderUrl: null,
        notice: result.revoked
          ? "Google account disconnected. Existing backups were not changed."
          : "Account forgotten locally. Google revocation could not be confirmed; remove the app grant in your Google account settings.",
      });
    });
  }
  abandonRetry(): void {
    if (!this.operation) {
      this.job = null;
      this.update({
        notice:
          "Next backup will be a new snapshot. Unfinished remote files were retained.",
      });
    }
  }
  private drive(): GoogleDriveBackups | GitHubBackups {
    if (
      this.value.preferences.mode === "temporary" &&
      this.value.preferences.destination === "google"
    )
      this.auth.token();
    if (!this.provider || !this.state.connected)
      throw new Error("Connect a backup destination first.");
    return this.provider;
  }
  backup(): Promise<void> {
    return this.run("preparing", async (signal) => {
      const drive = this.drive();
      if (!this.job) {
        const blob = await this.source.archive();
        signal.throwIfAborted();
        assertBackupSize(blob.size, this.maxBytes());
        const hash = await sha256(blob, signal);
        const worldKey = await sha256(new Blob([this.source.worldId]));
        signal.throwIfAborted();
        const name =
          this.source.worldName
            .replace(/[^\p{L}\p{N} _-]/gu, "")
            .trim()
            .slice(0, 60) || "world";
        this.job = {
          blob,
          name: `${name}-${new Date().toISOString().replace(/[:.]/g, "-")}.zip`,
          sha256: hash,
          worldKey,
        };
      }
      this.update({ phase: "uploading" });
      const saved = await drive.upload(this.job, signal, (fraction) => {
        if (!signal.aborted)
          this.update({
            progress: fraction,
            phase: fraction === 1 ? "verifying" : "uploading",
          });
      });
      signal.throwIfAborted();
      this.job = null;
      this.update({
        lastVerifiedAt: Date.now(),
        folderUrl: drive.folderUrl,
        backups: [
          saved,
          ...this.value.backups.filter((item) => item.id !== saved.id),
        ].slice(0, 20),
        notice:
          "Backup uploaded and checksum verified. Local autosave continues as usual.",
      });
    });
  }
  refresh(): Promise<void> {
    return this.run("listing", async (signal) => {
      const drive = this.drive();
      const backups = await drive.list(signal);
      signal.throwIfAborted();
      this.update({ backups, folderUrl: drive.folderUrl });
    });
  }
  download(id: string): Promise<{ blob: Blob; backup: DriveBackup }> {
    return this.run("downloading", async (signal) => {
      if (!this.value.backups.some((item) => item.id === id))
        throw new Error("Choose a backup from the list first.");
      const result = await this.drive().download(id, signal);
      signal.throwIfAborted();
      this.update({
        notice:
          "Download checksum verified. Use Open file on the start screen to inspect or restore it.",
      });
      return result;
    });
  }
  cancel(): void {
    this.operation?.abort();
    if (this.value.phase === "sign-in") this.auth.clear();
  }
  disconnect(): void {
    this.operation?.abort();
    this.operation = null;
    this.auth.clear();
    this.provider = null;
    this.job = null;
    const ready =
      this.value.preferences.mode === "temporary" && this.value.ready;
    const preferences = this.value.preferences;
    this.value = { ...initial(), preferences };
    this.update({
      ready,
      notice: "Disconnected locally. Existing backups were not changed.",
    });
  }
  dispose(): void {
    this.disposed = true;
    this.disconnect(); // Never revoke persistent accounts on world/tab close.
    this.listeners.clear();
  }
}
