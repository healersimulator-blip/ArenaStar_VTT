/** Bounded ZIP extraction shared by the World ZIP importer and its preview classifier. */
import {
  Unzip,
  UnzipInflate,
  UnzipPassThrough,
  type UnzipFile,
  type UnzipFileInfo,
} from "fflate";

export interface ZipExtractionLimits {
  /** Maximum compressed archive bytes accepted before scanning or reading a Blob. */
  maxArchiveBytes: number;
  /** Maximum aggregate uncompressed bytes extracted. */
  maxUncompressedBytes: number;
  /** Maximum uncompressed bytes in one entry. */
  maxEntryBytes: number;
  /** Maximum number of directory and file entries in the central directory. */
  maxEntries: number;
  /** Maximum UTF-8 path length in bytes. */
  maxPathBytes: number;
}

/**
 * Limits apply to imported/exported full World ZIPs. They are deliberately larger than the
 * selected-content bundle limits, but still bound compressed input, entry count, and expansion.
 */
export const WORLD_ZIP_LIMITS: Readonly<ZipExtractionLimits> = Object.freeze({
  maxArchiveBytes: 256 * 1024 * 1024,
  maxUncompressedBytes: 512 * 1024 * 1024,
  maxEntryBytes: 128 * 1024 * 1024,
  maxEntries: 100_000,
  maxPathBytes: 4096,
});

export type ZipEntryFilter = (file: UnzipFileInfo) => boolean;

const MiB = 1024 * 1024;

/** Tighter limits for indexes that are parsed and retained as JavaScript objects. */
export function worldZipEntryLimit(path: string): number {
  switch (path) {
    case "world.json":
      return 1 * MiB;
    case "documents.json":
      return 128 * MiB;
    case "assets.json":
      return 32 * MiB;
    case "packages.json":
      return 8 * MiB;
    case "fog.json":
      return 16 * MiB;
    default:
      return WORLD_ZIP_LIMITS.maxEntryBytes;
  }
}

const utf8 = new TextEncoder();

const safePath = (path: string, maxPathBytes: number): boolean => {
  if (
    path.length === 0 ||
    utf8.encode(path).byteLength > maxPathBytes ||
    path.includes("\0") ||
    path.includes("\\") ||
    path.startsWith("/") ||
    /^[A-Za-z]:/.test(path)
  )
    return false;
  const parts = path.split("/");
  if (parts.at(-1) === "") parts.pop(); // ordinary ZIP directory entry
  return (
    parts.length > 0 &&
    parts.every((part) => part.length > 0 && part !== "." && part !== "..")
  );
};

/** Extract selected ZIP entries while enforcing header and actual-output limits. */
export function extractZipEntriesBounded(
  bytes: Uint8Array,
  options: {
    limits?: Partial<ZipExtractionLimits>;
    filter?: ZipEntryFilter;
  } = {},
): Promise<Map<string, Uint8Array>> {
  const limits = { ...WORLD_ZIP_LIMITS, ...options.limits };
  if (!Number.isSafeInteger(bytes.byteLength) || bytes.byteLength === 0)
    return Promise.reject(
      new Error("ZIP archive is empty or has an invalid size."),
    );
  if (bytes.byteLength > limits.maxArchiveBytes)
    return Promise.reject(
      new Error(
        `ZIP archive exceeds the ${Math.ceil(limits.maxArchiveBytes / (1024 * 1024))} MiB compressed-size limit.`,
      ),
    );
  const hasZipSignature =
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    ((bytes[2] === 0x03 && bytes[3] === 0x04) ||
      (bytes[2] === 0x05 && bytes[3] === 0x06) ||
      (bytes[2] === 0x07 && bytes[3] === 0x08));
  if (!hasZipSignature)
    return Promise.reject(
      new Error("not a readable zip — invalid ZIP signature."),
    );

  return new Promise((resolve, reject) => {
    const files = new Map<string, Uint8Array>();
    const names = new Set<string>();
    const active = new Set<UnzipFile>();
    let entryCount = 0;
    let declaredTotal = 0;
    let actualTotal = 0;
    let pending = 0;
    let scanFinished = false;
    let settled = false;

    const cleanup = (): void => {
      for (const file of active) file.terminate();
      active.clear();
    };
    const fail = (message: string, cause?: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(message, cause === undefined ? undefined : { cause }));
    };
    const finishIfReady = (): void => {
      if (!settled && scanFinished && pending === 0) {
        settled = true;
        resolve(files);
      }
    };

    const unzip = new Unzip((file) => {
      if (settled) {
        file.terminate();
        return;
      }
      try {
        entryCount++;
        if (entryCount > limits.maxEntries)
          throw new Error(
            `ZIP contains more than ${limits.maxEntries} entries.`,
          );
        if (!safePath(file.name, limits.maxPathBytes))
          throw new Error(
            `ZIP contains an unsafe entry path: ${file.name.slice(0, 160)}.`,
          );
        if (names.has(file.name))
          throw new Error(
            `ZIP contains a duplicate entry path: ${file.name.slice(0, 160)}.`,
          );
        names.add(file.name);

        const isDirectory = file.name.endsWith("/");
        if (isDirectory) {
          if (file.originalSize !== undefined && file.originalSize !== 0)
            throw new Error(
              `ZIP directory entry ${file.name.slice(0, 160)} is not empty.`,
            );
          file.terminate();
          return;
        }

        const info: UnzipFileInfo = {
          name: file.name,
          size: file.size ?? 0,
          originalSize: file.originalSize ?? 0,
          compression: file.compression,
        };
        let selected = true;
        if (options.filter) selected = options.filter(info);
        if (!selected) {
          file.terminate();
          return;
        }
        if (file.compression !== 0 && file.compression !== 8)
          throw new Error(
            `ZIP entry ${file.name.slice(0, 160)} uses an unsupported compression method.`,
          );
        const entryLimit = Math.min(
          limits.maxEntryBytes,
          worldZipEntryLimit(file.name),
        );
        const expectedSize = file.originalSize;
        if (
          expectedSize !== undefined &&
          (!Number.isSafeInteger(expectedSize) || expectedSize < 0)
        )
          throw new Error(
            `ZIP entry ${file.name.slice(0, 160)} has an invalid uncompressed size.`,
          );
        if (expectedSize !== undefined && expectedSize > entryLimit)
          throw new Error(
            `ZIP entry ${file.name.slice(0, 160)} exceeds the per-entry size limit.`,
          );
        if (expectedSize !== undefined) {
          declaredTotal += expectedSize;
          if (declaredTotal > limits.maxUncompressedBytes)
            throw new Error(
              "ZIP exceeds the aggregate uncompressed-size limit.",
            );
        }

        let output = new Uint8Array(expectedSize ?? 0);
        let outputLength = 0;
        pending++;
        active.add(file);
        file.ondata = (error, chunk, final) => {
          if (settled) return;
          if (error) {
            fail(
              `ZIP entry ${file.name.slice(0, 160)} could not be decompressed.`,
              error,
            );
            return;
          }
          const nextLength = outputLength + chunk.byteLength;
          if (nextLength > entryLimit) {
            fail(
              `ZIP entry ${file.name.slice(0, 160)} exceeds the per-entry size limit.`,
            );
            return;
          }
          actualTotal += chunk.byteLength;
          if (actualTotal > limits.maxUncompressedBytes) {
            fail("ZIP exceeds the aggregate uncompressed-size limit.");
            return;
          }
          if (nextLength > output.byteLength) {
            let capacity = Math.max(64 * 1024, output.byteLength || 0);
            while (capacity < nextLength)
              capacity = Math.min(limits.maxEntryBytes, capacity * 2);
            const grown = new Uint8Array(capacity);
            grown.set(output.subarray(0, outputLength));
            output = grown;
          }
          output.set(chunk, outputLength);
          outputLength = nextLength;
          if (!final) return;
          if (expectedSize !== undefined && outputLength !== expectedSize) {
            fail(
              `ZIP entry ${file.name.slice(0, 160)} has a mismatched uncompressed size.`,
            );
            return;
          }
          files.set(file.name, output.subarray(0, outputLength));
          pending--;
          active.delete(file);
          finishIfReady();
        };
        file.start();
      } catch (error) {
        fail(
          error instanceof Error
            ? error.message
            : "ZIP entry could not be read.",
          error,
        );
      }
    });
    unzip.register(UnzipInflate);
    unzip.register(UnzipPassThrough);
    try {
      unzip.push(bytes, true);
      scanFinished = true;
      finishIfReady();
    } catch (error) {
      fail("ZIP central directory could not be scanned.", error);
    }
  });
}

/** Validate generated entries against the same path and expansion limits used at import. */
export function assertWorldZipEntriesWithinLimits(
  entries: ReadonlyArray<{ path: string; bytes: Uint8Array }>,
  limits: Readonly<ZipExtractionLimits> = WORLD_ZIP_LIMITS,
): void {
  if (entries.length > limits.maxEntries)
    throw new Error(
      `world file: archive exceeds the ${limits.maxEntries}-entry limit`,
    );
  const names = new Set<string>();
  let total = 0;
  for (const entry of entries) {
    if (!safePath(entry.path, limits.maxPathBytes))
      throw new Error(
        `world file: unsafe archive entry path ${entry.path.slice(0, 160)}`,
      );
    if (entry.path.endsWith("/"))
      throw new Error(
        `world file: generated archive contains an empty directory entry`,
      );
    if (names.has(entry.path))
      throw new Error(
        `world file: duplicate archive entry ${entry.path.slice(0, 160)}`,
      );
    names.add(entry.path);
    if (
      entry.bytes.byteLength >
      Math.min(limits.maxEntryBytes, worldZipEntryLimit(entry.path))
    )
      throw new Error(
        `world file: ${entry.path} exceeds the per-entry size limit`,
      );
    total += entry.bytes.byteLength;
    if (total > limits.maxUncompressedBytes)
      throw new Error(
        "world file: archive exceeds the aggregate uncompressed-size limit",
      );
  }
}
