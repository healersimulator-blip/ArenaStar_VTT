import { describe, expect, test } from "vitest";
import {
  CLOUD_BACKUP_LIMIT,
  GoogleDriveBackups,
  sha256,
  type BackupJob,
} from "../../src/storage/cloud/googleDrive";

const signal = () => new AbortController().signal;
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
interface FileRow {
  id: string;
  name: string;
  mimeType: string;
  appProperties: Record<string, string>;
  data: Uint8Array<ArrayBuffer>;
  expected: number;
}
function harness() {
  const files = new Map<string, FileRow>();
  const requests: Array<{ url: string; method: string }> = [];
  let ids = 0;
  let folder = false;
  const state = {
    failAfterChunk: false,
    checksum: true,
    corruptChecksum: false,
    corruptBody: false,
    evilLocation: false,
    httpStatus: 0,
  };
  const meta = async (file: FileRow) => ({
    id: file.id,
    name: file.name,
    mimeType: file.mimeType,
    appProperties: file.appProperties,
    size: String(file.data.length),
    createdTime: "2026-10-10T12:00:00.000Z",
    ...(state.checksum && file.data.length === file.expected
      ? {
          sha256Checksum: state.corruptChecksum
            ? "0".repeat(64)
            : await sha256(new Blob([file.data])),
        }
      : {}),
  });
  const fetcher: typeof fetch = async (input, init) => {
    init?.signal?.throwIfAborted();
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    requests.push({ url: url.href, method });
    expect(new Headers(init?.headers).get("Authorization")).toBe(
      "Bearer session-only-test-token",
    );
    expect(init?.redirect).toBe("error");
    if (state.httpStatus) return json({}, state.httpStatus);
    if (url.pathname.endsWith("generateIds"))
      return json({ ids: [`backup-${++ids}`] });
    const headers = new Headers(init?.headers);
    if (url.pathname.startsWith("/upload/")) {
      const uploadId = url.searchParams.get("upload_id");
      if (!uploadId) {
        const body = JSON.parse(String(init?.body)) as {
          id?: string;
          name: string;
          mimeType: string;
          appProperties: Record<string, string>;
        };
        const id = body.id ?? url.pathname.split("/").at(-1) ?? "";
        files.set(id, {
          ...body,
          id,
          data: new Uint8Array(),
          expected: Number(headers.get("X-Upload-Content-Length")),
        });
        return new Response(null, {
          status: 200,
          headers: {
            Location: state.evilLocation
              ? "https://attacker.example/upload"
              : `https://www.googleapis.com/upload/drive/v3/files?upload_id=${id}`,
          },
        });
      }
      const file = files.get(uploadId);
      if (!file) return json({}, 404);
      const range = headers.get("Content-Range") ?? "";
      if (!range.startsWith("bytes */")) {
        const chunk = new Uint8Array(await (init?.body as Blob).arrayBuffer());
        const merged = new Uint8Array(file.data.length + chunk.length);
        merged.set(file.data);
        merged.set(chunk, file.data.length);
        file.data = merged;
        if (state.failAfterChunk) {
          state.failAfterChunk = false;
          throw new TypeError("connection dropped after server received chunk");
        }
      }
      return file.data.length === file.expected
        ? json(await meta(file))
        : new Response(null, {
            status: 308,
            headers: file.data.length
              ? { Range: `bytes=0-${file.data.length - 1}` }
              : {},
          });
    }
    if (url.pathname === "/drive/v3/files") {
      if (method === "POST") {
        folder = true;
        return json({ id: "folder-1" });
      }
      const query = url.searchParams.get("q") ?? "";
      return query.includes("mimeType")
        ? json({ files: folder ? [{ id: "folder-1" }] : [] })
        : json({ files: await Promise.all([...files.values()].map(meta)) });
    }
    const id = url.pathname.split("/").at(-1) ?? "";
    const file = files.get(id);
    if (!file) return json({}, 404);
    if (method === "PATCH") {
      file.appProperties = (
        JSON.parse(String(init?.body)) as {
          appProperties: Record<string, string>;
        }
      ).appProperties;
      return json(await meta(file));
    }
    if (url.searchParams.get("alt") === "media")
      return new Response(
        state.corruptBody ? new Uint8Array([0, 1, 2, 3]) : file.data,
      );
    return json(await meta(file));
  };
  const drive = new GoogleDriveBackups(
    () => "session-only-test-token",
    fetcher,
  );
  return { drive, files, requests, state };
}
async function job(size = 16): Promise<BackupJob> {
  const blob = new Blob([new Uint8Array(size).fill(42)], {
    type: "application/zip",
  });
  return {
    blob,
    sha256: await sha256(blob),
    name: "test-world.zip",
    worldKey: "a".repeat(64),
  };
}

describe("Google Drive binary world backup prototype", () => {
  test("new snapshot uploads, verifies SHA256, lists and downloads; no overwrites or deletions", async () => {
    const h = harness();
    expect(await h.drive.list(signal())).toEqual([]);
    const first = await job();
    const result = await h.drive.upload(first, signal(), () => {});
    expect(result.verified).toBe(true);
    expect(result.sha256).toBe(first.sha256);
    const second = await h.drive.upload(await job(20), signal(), () => {});
    expect(second.id).not.toBe(result.id);
    expect((await h.drive.list(signal())).map((file) => file.id)).toEqual([
      result.id,
      second.id,
    ]);
    expect(
      await (await h.drive.download(result.id, signal())).blob.arrayBuffer(),
    ).toEqual(await first.blob.arrayBuffer());
    expect(h.requests.some((request) => request.method === "DELETE")).toBe(
      false,
    );
    expect(JSON.stringify(first)).not.toContain("session-only-test-token");
  });

  test("retry after an uncertain chunk response resumes the same snapshot/file ID", async () => {
    const h = harness();
    const snapshot = await job(4 * 1024 * 1024 + 20);
    h.state.failAfterChunk = true;
    await expect(h.drive.upload(snapshot, signal(), () => {})).rejects.toThrow(
      "Could not reach",
    );
    expect(h.files.size).toBe(1);
    const id = snapshot.fileId;
    const result = await h.drive.upload(snapshot, signal(), () => {});
    expect(result.id).toBe(id);
    expect(h.files.size).toBe(1);
    expect(
      h.requests.filter((request) => request.url.includes("generateIds")),
    ).toHaveLength(1);
    expect(h.files.get(result.id)?.data.length).toBe(snapshot.blob.size);
  });

  test("retry after complete upload but lost response verifies rather than duplicating", async () => {
    const h = harness();
    const snapshot = await job();
    h.state.failAfterChunk = true;
    await expect(
      h.drive.upload(snapshot, signal(), () => {}),
    ).rejects.toThrow();
    expect((await h.drive.upload(snapshot, signal(), () => {})).verified).toBe(
      true,
    );
    expect(h.files.size).toBe(1);
  });

  test("checksum mismatch is never marked verified; download also checks actual content", async () => {
    const h = harness();
    const snapshot = await job();
    h.state.corruptChecksum = true;
    await expect(h.drive.upload(snapshot, signal(), () => {})).rejects.toThrow(
      "checksum",
    );
    expect([...h.files.values()][0]?.appProperties.state).toBe("unverified");
    h.state.corruptChecksum = false;
    const result = await h.drive.upload(snapshot, signal(), () => {});
    h.state.corruptBody = true;
    await expect(h.drive.download(result.id, signal())).rejects.toThrow(
      "checksum",
    );
  });

  test("missing provider checksum triggers read-back verification", async () => {
    const h = harness();
    h.state.checksum = false;
    const result = await h.drive.upload(await job(), signal(), () => {});
    expect(result.verified).toBe(true);
    expect(
      h.requests.some((request) => request.url.includes("alt=media")),
    ).toBe(true);
  });

  test("untrusted resumable URL is rejected before credentials leave the approved API origin", async () => {
    const h = harness();
    h.state.evilLocation = true;
    await expect(
      h.drive.upload(await job(), signal(), () => {}),
    ).rejects.toThrow("unexpected upload address");
    expect(
      h.requests.every(
        (request) =>
          new URL(request.url).origin === "https://www.googleapis.com",
      ),
    ).toBe(true);
  });

  test("oversized archive fails before any cloud request", async () => {
    const h = harness();
    const snapshot = await job();
    snapshot.blob = { size: CLOUD_BACKUP_LIMIT + 1 } as Blob;
    await expect(h.drive.upload(snapshot, signal(), () => {})).rejects.toThrow(
      "configured size limit",
    );
    expect(h.requests).toHaveLength(0);
  });

  test.each([401, 403, 429, 503])(
    "provider HTTP %s leaves previous backups untouched",
    async (status) => {
      const h = harness();
      const first = await h.drive.upload(await job(), signal(), () => {});
      h.state.httpStatus = status;
      await expect(
        h.drive.upload(await job(17), signal(), () => {}),
      ).rejects.toThrow();
      expect(h.files.get(first.id)?.appProperties.state).toBe("verified");
      expect(h.requests.some((request) => request.method === "DELETE")).toBe(
        false,
      );
    },
  );

  test("cancelled operation cannot report success", async () => {
    const h = harness();
    const controller = new AbortController();
    controller.abort();
    await expect(
      h.drive.upload(await job(), controller.signal, () => {}),
    ).rejects.toThrow();
    expect(h.files.size).toBe(0);
  });
});
