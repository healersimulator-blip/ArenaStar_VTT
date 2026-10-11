import {
  DriveError,
  sha256,
  type BackupJob,
  type DriveBackup,
} from "./googleDrive";
import { assertBackupSize } from "./preferences";
export interface CompanionStatus {
  available: boolean;
  paired: boolean;
  googleConfigured: boolean;
  googleConnected: boolean;
  googleAttempt?: string | null;
  githubConfigured: boolean;
}
export class CloudCompanion {
  async request<T>(
    path: string,
    body?: object,
    signal?: AbortSignal,
  ): Promise<T> {
    const response = await fetch(`/api/cloud/${path}`, {
      method: body ? "POST" : "GET",
      credentials: "same-origin",
      redirect: "error",
      cache: "no-store",
      headers: {
        "X-ArenaStar-Cloud": "1",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: signal ?? AbortSignal.timeout(60_000),
    });
    if (!response.headers.get("content-type")?.includes("application/json"))
      throw new Error(
        "Remembered connections need the backup companion. See CLOUD_BACKUP_PROTOTYPE.md for setup, or choose temporary Google sign-in.",
      );
    const data = (await response.json()) as T & { error?: string };
    if (!response.ok)
      throw new DriveError(
        data.error ?? "Backup companion request failed.",
        response.status,
      );
    return data;
  }
  status(signal?: AbortSignal): Promise<CompanionStatus> {
    return this.request("status", undefined, signal);
  }
  async token(): Promise<string> {
    return (await this.request<{ token: string }>("google/token", {})).token;
  }
  async pair(key: string, signal: AbortSignal): Promise<void> {
    await this.request("pair", { key }, signal);
  }
  async connectGoogle(signal: AbortSignal): Promise<void> {
    // Open synchronously from the click, before the asynchronous start request.
    const popup = window.open(
      "about:blank",
      "arenastar-cloud-sign-in",
      "popup,width=520,height=680",
    );
    if (!popup)
      throw new Error("Allow the Google sign-in popup and try again.");
    let attempt: string | undefined;
    try {
      popup.opener = null;
      const result = await this.request<{ url: string; attempt: string }>(
        "google/start",
        {},
        signal,
      );
      const { url } = result;
      attempt = result.attempt;
      if (new URL(url).origin !== "https://accounts.google.com")
        throw new Error("Unexpected sign-in address.");
      popup.location.href = url;
      const deadline = Date.now() + 10 * 60_000;
      for (;;) {
        signal.throwIfAborted();
        if ((await this.status(signal)).googleAttempt === attempt) return;
        if (popup.closed)
          throw new Error("Google sign-in was closed before completion.");
        if (Date.now() > deadline)
          throw new Error("Google sign-in timed out. Try again.");
        await new Promise<void>((resolve, reject) => {
          const stop = () => {
            clearTimeout(timer);
            reject(new Error("Sign-in cancelled."));
          };
          const timer = setTimeout(() => {
            signal.removeEventListener("abort", stop);
            resolve();
          }, 1500);
          signal.addEventListener("abort", stop, { once: true });
        });
      }
    } finally {
      popup.close();
      if (attempt)
        void this.request(
          "google/cancel",
          { attempt },
          AbortSignal.timeout(5000),
        ).catch(() => undefined);
    }
  }
}
export class GitHubBackups {
  readonly folderUrl: string;
  constructor(
    private readonly companion: CloudCompanion,
    private readonly repository: string,
    private readonly maxBytes: () => number,
  ) {
    this.folderUrl = `https://github.com/${repository}/releases`;
  }
  private path(action: string): string {
    return `github/${action}?repo=${encodeURIComponent(this.repository)}`;
  }
  async connect(signal: AbortSignal): Promise<void> {
    await this.companion.request(this.path("check"), {}, signal);
  }
  list(signal: AbortSignal): Promise<DriveBackup[]> {
    return this.companion.request(this.path("list"), undefined, signal);
  }
  async upload(
    job: BackupJob,
    signal: AbortSignal,
    progress: (fraction: number) => void,
  ): Promise<DriveBackup> {
    assertBackupSize(job.blob.size, this.maxBytes());
    if (job.blob.size > 2 * 1024 ** 3)
      throw new Error(
        "GitHub release backups support at most 2 GiB per ZIP. Choose Google Drive or local export.",
      );
    job.fileId ??= crypto.randomUUID();
    const manifest = {
      format: "arenastar-vtt-backup-v2",
      snapshot: job.fileId,
      name: job.name,
      size: job.blob.size,
      sha256: job.sha256,
      worldKey: job.worldKey,
    };
    const encoded = btoa(
      Array.from(new TextEncoder().encode(JSON.stringify(manifest)), (byte) =>
        String.fromCharCode(byte),
      ).join(""),
    );
    // XHR provides byte progress without buffering a second copy of a large Blob.
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const abort = () => xhr.abort();
      const cleanup = () => signal.removeEventListener("abort", abort);
      xhr.open("POST", `/api/cloud/${this.path("upload")}`);
      xhr.setRequestHeader("X-ArenaStar-Cloud", "1");
      xhr.setRequestHeader("X-Backup-Manifest", encoded);
      xhr.setRequestHeader("Content-Type", "application/zip");
      xhr.timeout = 30 * 60_000;
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) progress(event.loaded / event.total);
      };
      xhr.onload = () => {
        cleanup();
        try {
          const data = JSON.parse(xhr.responseText) as DriveBackup & {
            error?: string;
          };
          if (xhr.status < 200 || xhr.status >= 300)
            throw new DriveError(
              data.error ?? "GitHub upload failed.",
              xhr.status,
            );
          if (
            !data.verified ||
            data.sha256 !== job.sha256 ||
            data.size !== job.blob.size
          )
            throw new Error("GitHub verification did not match this snapshot.");
          progress(1);
          resolve(data);
        } catch (error) {
          reject(error);
        }
      };
      xhr.onerror = xhr.ontimeout = () => {
        cleanup();
        reject(
          new Error(
            "GitHub upload interrupted. Retry this snapshot when the companion is available.",
          ),
        );
      };
      xhr.onabort = () => {
        cleanup();
        reject(new Error("GitHub upload cancelled."));
      };
      if (signal.aborted) {
        cleanup();
        reject(new Error("GitHub upload cancelled."));
        return;
      }
      signal.addEventListener("abort", abort, { once: true });
      xhr.send(job.blob);
    });
  }
  async download(
    id: string,
    signal: AbortSignal,
  ): Promise<{ blob: Blob; backup: DriveBackup }> {
    const backup = (await this.list(signal)).find((item) => item.id === id);
    if (!backup)
      throw new Error(
        "Backup is no longer in the recent list. Refresh and try again.",
      );
    assertBackupSize(backup.size, this.maxBytes());
    const response = await fetch(
      `/api/cloud/${this.path("download")}&id=${encodeURIComponent(id)}`,
      {
        credentials: "same-origin",
        redirect: "error",
        cache: "no-store",
        signal,
      },
    );
    if (!response.ok || !response.body)
      throw new Error(
        "GitHub download failed. Check companion connection and repository access.",
      );
    const reader = response.body.getReader();
    const parts: BlobPart[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > backup.size) throw new Error("Backup size mismatch.");
        parts.push(value as Uint8Array<ArrayBuffer>);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    const blob = new Blob(parts, { type: "application/zip" });
    if (size !== backup.size || (await sha256(blob, signal)) !== backup.sha256)
      throw new Error("Backup checksum mismatch. No download was saved.");
    return { blob, backup };
  }
}
