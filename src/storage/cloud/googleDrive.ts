import { sha256 as hash256 } from "@noble/hashes/sha2.js";
import { assertBackupSize } from "./preferences";
/** Optional Drive backup prototype. New binary files only; never prunes or overwrites other snapshots. */
export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
export const CLOUD_BACKUP_LIMIT = 512 * 1024 * 1024; // Default only; GM may change/disable it.
const API = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
const FIELDS = "id,name,size,createdTime,sha256Checksum,appProperties,mimeType";
const CHUNK = 4 * 1024 * 1024;
const HASH = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9_-]{1,200}$/;

export interface DriveBackup {
  id: string;
  name: string;
  size: number;
  createdTime: string;
  sha256: string;
  verified: boolean;
}
interface DriveFile {
  id: string;
  name?: string;
  size?: string;
  createdTime?: string;
  sha256Checksum?: string;
  mimeType?: string;
  appProperties?: Record<string, string>;
}
export interface BackupJob {
  blob: Blob;
  name: string;
  sha256: string;
  worldKey: string;
  fileId?: string;
  uploadUrl?: string;
}
export class DriveError extends Error {
  constructor(
    message: string,
    readonly status = 0,
  ) {
    super(message);
  }
}
export async function sha256(
  blob: Blob,
  signal?: AbortSignal,
): Promise<string> {
  const hash = hash256.create();
  // Hash in slices: large media worlds do not need another whole-archive ArrayBuffer.
  for (let offset = 0; offset < blob.size; offset += CHUNK) {
    signal?.throwIfAborted();
    hash.update(
      new Uint8Array(await blob.slice(offset, offset + CHUNK).arrayBuffer()),
    );
  }
  return Array.from(hash.digest(), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function fileId(id: string): string {
  if (typeof id !== "string" || !ID.test(id))
    throw new DriveError("Drive returned an invalid file identifier.");
  return id;
}
function safeUrl(url: string): string {
  const parsed = new URL(url);
  if (
    parsed.origin !== "https://www.googleapis.com" ||
    parsed.username ||
    parsed.password ||
    parsed.hash ||
    !(
      parsed.pathname.startsWith("/drive/v3/") ||
      parsed.pathname === "/upload/drive/v3/files" ||
      /^\/upload\/drive\/v3\/files\/[A-Za-z0-9_-]+$/.test(parsed.pathname)
    )
  )
    throw new DriveError(
      "Drive returned an unexpected upload address; no credentials were sent.",
    );
  return parsed.href;
}
function backupOf(file: DriveFile): DriveBackup {
  const props = file.appProperties;
  const size = Number(file.size);
  if (
    file.mimeType !== "application/zip" ||
    props?.arenaStarBackup !== "1" ||
    !HASH.test(props.sha256 ?? "") ||
    !Number.isSafeInteger(size) ||
    size < 1
  )
    throw new DriveError("This is not a supported ArenaStar backup.");
  return {
    id: fileId(file.id),
    name: typeof file.name === "string" ? file.name : "ArenaStar backup.zip",
    size,
    createdTime: typeof file.createdTime === "string" ? file.createdTime : "",
    sha256: props.sha256 as string,
    verified: props.state === "verified",
  };
}

export class GoogleDriveBackups {
  private folderId: string | null = null;
  constructor(
    private readonly token: () => string | Promise<string>,
    private readonly fetcher: typeof fetch = fetch,
    private readonly maxBytes: () => number = () => CLOUD_BACKUP_LIMIT,
  ) {}
  get folderUrl(): string | null {
    return this.folderId
      ? `https://drive.google.com/drive/folders/${this.folderId}`
      : null;
  }
  private async request(
    url: string,
    signal: AbortSignal,
    init: RequestInit = {},
    accept: number[] = [],
  ): Promise<Response> {
    // Validate BEFORE obtaining/sending a token. Never follow a credential-bearing redirect.
    const address = safeUrl(url);
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${await this.token()}`);
    let response: Response;
    try {
      response = await this.fetcher.call(globalThis, address, {
        ...init,
        headers,
        signal,
        redirect: "error",
        credentials: "omit",
        referrerPolicy: "no-referrer",
      });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new DriveError(
        "Could not reach Google Drive. Check your connection, then retry.",
      );
    }
    if (!response.ok && !accept.includes(response.status)) {
      if (response.status === 401)
        throw new DriveError(
          "Google sign-in expired. Connect Google Drive again.",
          401,
        );
      if (response.status === 403)
        throw new DriveError(
          "Drive refused access. Check app permission, folder access and storage quota.",
          403,
        );
      if (response.status === 429)
        throw new DriveError(
          "Drive is rate-limiting requests. Wait a moment before retrying.",
          429,
        );
      throw new DriveError(
        `Drive request failed (${response.status}). Retry later; existing backups were not changed.`,
        response.status,
      );
    }
    return response;
  }
  private async metadata(
    id: string,
    signal: AbortSignal,
  ): Promise<DriveFile | null> {
    const response = await this.request(
      `${API}/files/${fileId(id)}?fields=${FIELDS}`,
      signal,
      {},
      [404],
    );
    if (response.status === 404) return null;
    const file = (await response.json()) as DriveFile;
    if (file.id !== id)
      throw new DriveError(
        "Drive file identity did not match the requested backup.",
      );
    return file;
  }
  private async folder(
    signal: AbortSignal,
    create: boolean,
  ): Promise<string | null> {
    if (this.folderId) return this.folderId;
    const query =
      "trashed = false and mimeType = 'application/vnd.google-apps.folder' and appProperties has { key='arenaStarBackupFolder' and value='1' }";
    const response = await this.request(
      `${API}/files?${new URLSearchParams({ q: query, spaces: "drive", fields: "files(id)", pageSize: "1" })}`,
      signal,
    );
    const found = (await response.json()) as { files?: Array<{ id: string }> };
    const existing = found.files?.[0];
    if (existing) this.folderId = fileId(existing.id);
    if (!this.folderId && create) {
      const created = await this.request(`${API}/files?fields=id`, signal, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "ArenaStar backups",
          mimeType: "application/vnd.google-apps.folder",
          appProperties: { arenaStarBackupFolder: "1" },
        }),
      });
      this.folderId = fileId(((await created.json()) as { id: string }).id);
    }
    return this.folderId;
  }
  /** Latest 20 snapshots across worlds: a fresh device can recover without knowing a lost world ID. */
  async list(signal: AbortSignal): Promise<DriveBackup[]> {
    const folder = await this.folder(signal, false);
    if (!folder) return [];
    const q = `'${folder}' in parents and trashed = false and appProperties has { key='arenaStarBackup' and value='1' }`;
    const response = await this.request(
      `${API}/files?${new URLSearchParams({ q, spaces: "drive", fields: `files(${FIELDS})`, pageSize: "20", orderBy: "createdTime desc" })}`,
      signal,
    );
    const result = (await response.json()) as { files?: DriveFile[] };
    return (result.files ?? []).flatMap((file) => {
      try {
        return [backupOf(file)];
      } catch {
        return [];
      } // Unknown/oversized entries are never auto-imported.
    });
  }
  private async readBytes(file: DriveFile, signal: AbortSignal): Promise<Blob> {
    const backup = backupOf(file);
    assertBackupSize(backup.size, this.maxBytes());
    const response = await this.request(
      `${API}/files/${backup.id}?alt=media`,
      signal,
    );
    if (!response.body) throw new DriveError("Drive returned no backup data.");
    const reader = response.body.getReader();
    const parts: Uint8Array<ArrayBuffer>[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (
          total > backup.size ||
          (this.maxBytes() > 0 && total > this.maxBytes())
        )
          throw new DriveError("Backup download exceeded its declared size.");
        parts.push(new Uint8Array(value));
      }
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      throw error;
    } finally {
      reader.releaseLock();
    }
    const blob = new Blob(parts, { type: "application/zip" });
    if (total !== backup.size || (await sha256(blob, signal)) !== backup.sha256)
      throw new DriveError(
        "Backup checksum did not match. This download must not be restored.",
      );
    return blob;
  }
  async download(
    id: string,
    signal: AbortSignal,
  ): Promise<{ blob: Blob; backup: DriveBackup }> {
    const file = await this.metadata(id, signal);
    if (!file)
      throw new DriveError("This backup is no longer available in Drive.");
    const backup = backupOf(file);
    return { blob: await this.readBytes(file, signal), backup };
  }
  private async verify(
    job: BackupJob,
    signal: AbortSignal,
  ): Promise<DriveBackup> {
    const file = job.fileId ? await this.metadata(job.fileId, signal) : null;
    if (
      !file ||
      file.appProperties?.sha256 !== job.sha256 ||
      Number(file.size) !== job.blob.size
    )
      throw new DriveError(
        "Drive has not confirmed the complete backup. Retry this snapshot.",
      );
    if (file.sha256Checksum) {
      if (file.sha256Checksum.toLowerCase() !== job.sha256)
        throw new DriveError(
          "Uploaded backup checksum did not match. Existing backups are unchanged.",
        );
    } else {
      await this.readBytes(file, signal);
    }
    // Only mark verified after the server checksum (or a full download) agrees.
    const response = await this.request(
      `${API}/files/${fileId(file.id)}?fields=${FIELDS}`,
      signal,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          appProperties: { ...file.appProperties, state: "verified" },
        }),
      },
    );
    const confirmed = (await response.json()) as DriveFile;
    const backup = backupOf(confirmed);
    if (
      backup.id !== job.fileId ||
      !backup.verified ||
      backup.sha256 !== job.sha256 ||
      backup.size !== job.blob.size
    )
      throw new DriveError(
        "Drive did not confirm backup verification. Retry this snapshot.",
      );
    return backup;
  }
  async upload(
    job: BackupJob,
    signal: AbortSignal,
    progress: (fraction: number) => void,
  ): Promise<DriveBackup> {
    if (
      job.blob.size < 1 ||
      (this.maxBytes() > 0 && job.blob.size > this.maxBytes()) ||
      !HASH.test(job.sha256)
    )
      throw new DriveError(
        "Backup exceeds the configured size limit or has an invalid checksum. Adjust the limit in Cloud backups.",
      );
    const folder = await this.folder(signal, true);
    if (!folder)
      throw new DriveError("Could not create the Drive backup folder.");
    if (!job.fileId) {
      const response = await this.request(
        `${API}/files/generateIds?count=1&space=drive&type=files`,
        signal,
      );
      const ids = ((await response.json()) as { ids?: string[] }).ids;
      job.fileId = fileId(ids?.[0] ?? "");
    }
    const previous = await this.metadata(job.fileId, signal);
    if (previous) {
      if (
        previous.appProperties?.arenaStarBackup !== "1" ||
        previous.appProperties.sha256 !== job.sha256 ||
        previous.appProperties.worldKey !== job.worldKey
      )
        throw new DriveError(
          "Backup identity conflict. Disconnect to start a new snapshot; no file was overwritten.",
        );
      if (
        Number(previous.size) === job.blob.size &&
        (!previous.sha256Checksum ||
          previous.sha256Checksum.toLowerCase() === job.sha256)
      )
        return this.verify(job, signal);
      if (previous.appProperties.state === "verified")
        throw new DriveError("A verified backup will not be overwritten.");
    }
    if (!job.uploadUrl) {
      const properties = {
        arenaStarBackup: "1",
        sha256: job.sha256,
        worldKey: job.worldKey,
        state: "unverified",
      };
      const metadata = previous
        ? {
            name: job.name,
            mimeType: "application/zip",
            appProperties: properties,
          }
        : {
            id: job.fileId,
            name: job.name,
            mimeType: "application/zip",
            parents: [folder],
            appProperties: properties,
          };
      const response = await this.request(
        `${UPLOAD}${previous ? `/${job.fileId}` : ""}?uploadType=resumable`,
        signal,
        {
          method: previous ? "PATCH" : "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Upload-Content-Type": "application/zip",
            "X-Upload-Content-Length": String(job.blob.size),
          },
          body: JSON.stringify(metadata),
        },
      );
      const location = response.headers.get("Location");
      if (!location)
        throw new DriveError(
          "Drive did not expose a resumable upload address. Check browser/CORS support.",
        );
      job.uploadUrl = safeUrl(location);
    }
    // Probe first, including on Retry: the same generated file ID and bytes are reused.
    let response = await this.request(
      job.uploadUrl,
      signal,
      {
        method: "PUT",
        headers: { "Content-Range": `bytes */${job.blob.size}` },
      },
      [308, 404, 410],
    );
    let sent = -1;
    while (response.status === 308) {
      const range = response.headers.get("Range");
      if (range && !/^bytes=0-\d+$/.test(range))
        throw new DriveError("Drive returned an invalid upload range.");
      const offset = range ? Number(range.slice(8)) + 1 : 0;
      if (
        !Number.isSafeInteger(offset) ||
        offset <= sent ||
        offset >= job.blob.size
      )
        throw new DriveError(
          "Drive upload made no progress. Retry this snapshot.",
        );
      sent = offset;
      progress(offset / job.blob.size);
      const end = Math.min(offset + CHUNK, job.blob.size);
      response = await this.request(
        job.uploadUrl,
        signal,
        {
          method: "PUT",
          headers: {
            "Content-Type": "application/zip",
            "Content-Range": `bytes ${offset}-${end - 1}/${job.blob.size}`,
          },
          body: job.blob.slice(offset, end),
        },
        [308, 404, 410],
      );
    }
    if (response.status === 404 || response.status === 410) {
      delete job.uploadUrl;
      throw new DriveError(
        "Drive upload session expired. Retry resumes this snapshot using its reserved file ID.",
      );
    }
    progress(1);
    return this.verify(job, signal);
  }
}
