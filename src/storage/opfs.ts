/**
 * §7/§8 OPFS blob store: /vtt/<worldId>/assets/<hash>, content-addressed.
 * Handles are abstracted (DirHandleLike) so tests run against an in-memory
 * fake (D-028); the real implementation wraps navigator.storage.getDirectory().
 */
import type { AssetId, WorldId } from "../core/ids";

export interface FileLike {
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface WritableLike {
  write(data: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

export interface FileHandleLike {
  createWritable(): Promise<WritableLike>;
  getFile(): Promise<FileLike>;
}

export interface DirHandleLike {
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<DirHandleLike>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FileHandleLike>;
  removeEntry(name: string): Promise<void>;
}

/** Real OPFS root, or null where unsupported (§15 file:// on some browsers). */
export async function opfsRoot(): Promise<DirHandleLike | null> {
  const nav = globalThis.navigator as
    { storage?: { getDirectory?: () => Promise<DirHandleLike> } } | undefined;
  if (typeof nav?.storage?.getDirectory !== "function") return null;
  try {
    return await nav.storage.getDirectory();
  } catch {
    return null;
  }
}

/**
 * Blob store for one world's assets under /vtt/<worldId>/assets/.
 * `null` from open() means OPFS is unavailable — callers fall back to IDB
 * blobs (AssetServer unit decides).
 */
export class OpfsAssetStore {
  private constructor(
    private readonly assetsDir: DirHandleLike,
    readonly worldId: WorldId,
  ) {}

  static async open(worldId: WorldId, root: DirHandleLike | null): Promise<OpfsAssetStore | null> {
    if (!root) return null;
    const vtt = await root.getDirectoryHandle("vtt", { create: true });
    const world = await vtt.getDirectoryHandle(worldId, { create: true });
    const assets = await world.getDirectoryHandle("assets", { create: true });
    return new OpfsAssetStore(assets, worldId);
  }

  async put(hash: AssetId, bytes: Uint8Array): Promise<void> {
    const handle = await this.assetsDir.getFileHandle(hash, { create: true });
    const writable = await handle.createWritable();
    await writable.write(bytes);
    await writable.close();
  }

  async get(hash: AssetId): Promise<Uint8Array | undefined> {
    try {
      const handle = await this.assetsDir.getFileHandle(hash);
      const file = await handle.getFile();
      return new Uint8Array(await file.arrayBuffer());
    } catch {
      return undefined;
    }
  }

  async has(hash: AssetId): Promise<boolean> {
    return (await this.get(hash)) !== undefined;
  }

  async remove(hash: AssetId): Promise<void> {
    try {
      await this.assetsDir.removeEntry(hash);
    } catch {
      // absent — idempotent
    }
  }

  /** All stored hashes (opfs list is opaque; discovered via known set). */
  async list(known: readonly AssetId[]): Promise<AssetId[]> {
    const present: AssetId[] = [];
    for (const hash of known) {
      if (await this.has(hash)) present.push(hash);
    }
    return present;
  }
}

// ─── in-memory fake for tests (D-028) ─────────────────────────────────────────

class MemFile implements FileLike {
  constructor(readonly bytes: Uint8Array) {}
  async arrayBuffer(): Promise<ArrayBuffer> {
    return this.bytes.buffer.slice(
      this.bytes.byteOffset,
      this.bytes.byteOffset + this.bytes.byteLength,
    ) as ArrayBuffer;
  }
}

class MemWritable implements WritableLike {
  constructor(private readonly target: MemFileHandle) {}
  async write(data: Uint8Array): Promise<void> {
    this.target.file = new MemFile(new Uint8Array(data));
  }
  async close(): Promise<void> {}
}

class MemFileHandle implements FileHandleLike {
  file: MemFile = new MemFile(new Uint8Array(0));
  async createWritable(): Promise<WritableLike> {
    return new MemWritable(this);
  }
  async getFile(): Promise<FileLike> {
    return this.file;
  }
}

export class MemDirHandle implements DirHandleLike {
  readonly dirs = new Map<string, MemDirHandle>();
  readonly files = new Map<string, MemFileHandle>();

  async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<DirHandleLike> {
    const existing = this.dirs.get(name);
    if (existing) return existing;
    if (!options?.create) throw new Error(`NotFoundError: ${name}`);
    const created = new MemDirHandle();
    this.dirs.set(name, created);
    return created;
  }

  async getFileHandle(name: string, options?: { create?: boolean }): Promise<FileHandleLike> {
    const existing = this.files.get(name);
    if (existing) return existing;
    if (!options?.create) throw new Error(`NotFoundError: ${name}`);
    const created = new MemFileHandle();
    this.files.set(name, created);
    return created;
  }

  async removeEntry(name: string): Promise<void> {
    if (!this.dirs.delete(name)) this.files.delete(name);
  }
}
