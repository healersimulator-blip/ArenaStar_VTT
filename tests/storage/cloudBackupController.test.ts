import { afterEach, describe, expect, test, vi } from "vitest";
import { GoogleDriveAuth } from "../../src/storage/cloud/googleAuth";
import { CloudBackupController } from "../../src/storage/cloud/cloudBackup";

class TestAuth extends GoogleDriveAuth {
  private live = false;
  override get connected() {
    return this.live;
  }
  override async prepare(): Promise<void> {}
  override async connect(): Promise<void> {
    this.live = true;
  }
  override token(): string {
    if (!this.live) throw new Error("Connect first");
    return "test-token";
  }
  override clear(): void {
    this.live = false;
  }
}
afterEach(() => vi.unstubAllGlobals());

async function setup(archive: () => Promise<Blob>) {
  const requests = vi.fn<typeof fetch>(
    async () => new Response(JSON.stringify({ files: [] }), { status: 200 }),
  );
  vi.stubGlobal("fetch", requests);
  const auth = new TestAuth();
  const cloud = new CloudBackupController(
    { worldId: "test-world", worldName: "Test", archive },
    auth,
  );
  await cloud.prepare("public-client-id");
  await cloud.connect();
  return { cloud, requests, auth };
}

describe("cloud jobs are isolated from routine local saving", () => {
  test("export-rights/preparation failure uploads nothing and reports no verified backup", async () => {
    const { cloud, requests } = await setup(async () => {
      throw new Error("Media export rights not granted");
    });
    const before = requests.mock.calls.length;
    await expect(cloud.backup()).rejects.toThrow("export rights");
    expect(requests.mock.calls.length).toBe(before);
    expect(cloud.state.lastVerifiedAt).toBeNull();
    expect(cloud.state.error).toContain("export rights");
    cloud.dispose();
  });
  test("double-click cannot create parallel snapshots; cancel during preparation prevents upload", async () => {
    let release: (blob: Blob) => void = () => {};
    const waiting = new Promise<Blob>((resolve) => {
      release = resolve;
    });
    const archive = vi.fn(() => waiting);
    const { cloud, requests } = await setup(archive);
    const before = requests.mock.calls.length;
    const first = cloud.backup();
    await expect(cloud.backup()).rejects.toThrow("already running");
    expect(archive).toHaveBeenCalledOnce();
    cloud.cancel();
    release(new Blob(["world"]));
    await expect(first).rejects.toThrow();
    expect(requests.mock.calls.length).toBe(before);
    expect(cloud.state.lastVerifiedAt).toBeNull();
    cloud.dispose();
  });
  test("disconnect during preparation discards credentials and ignores late work", async () => {
    let release: (blob: Blob) => void = () => {};
    const waiting = new Promise<Blob>((resolve) => {
      release = resolve;
    });
    const { cloud, requests, auth } = await setup(() => waiting);
    const before = requests.mock.calls.length;
    const first = cloud.backup();
    cloud.disconnect();
    release(new Blob(["world"]));
    await expect(first).rejects.toThrow();
    expect(requests.mock.calls.length).toBe(before);
    expect(auth.connected).toBe(false);
    expect(cloud.state.canRetry).toBe(false);
    expect(cloud.state.error).toBeNull();
    expect(cloud.state.backups).toEqual([]);
  });
  test("Drive 401 clears the session and offers reconnection, not a successful backup", async () => {
    const { cloud, requests, auth } = await setup(
      async () => new Blob(["world"]),
    );
    requests.mockImplementation(
      async () => new Response(null, { status: 401 }),
    );
    await expect(cloud.refresh()).rejects.toThrow("expired");
    expect(auth.connected).toBe(false);
    expect(cloud.state.lastVerifiedAt).toBeNull();
    cloud.dispose();
  });
});

test("remembered GitHub connection restores on each world, and dispose does not forget saved credentials", async () => {
  vi.stubGlobal("localStorage", {
    getItem: () =>
      JSON.stringify({
        destination: "github",
        mode: "remembered",
        repository: "gm/backups",
        maxMiB: 512,
      }),
  });
  const requests = vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    const body = url.endsWith("/status")
      ? {
          paired: true,
          available: true,
          googleConfigured: false,
          googleConnected: false,
          githubConfigured: true,
        }
      : url.includes("/check?")
        ? { connected: true }
        : [];
    return new Response(JSON.stringify(body), {
      headers: { "Content-Type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", requests);
  const source = {
    worldId: "world",
    worldName: "World",
    archive: async () => new Blob(["world"]),
  };
  const first = new CloudBackupController(source);
  await first.restore();
  expect(first.state.connected).toBe(true);
  expect(first.state.folderUrl).toBe("https://github.com/gm/backups/releases");
  first.dispose();
  expect(
    requests.mock.calls.some(([url]) =>
      /forget|unpair|start/.test(String(url)),
    ),
  ).toBe(false);
  const second = new CloudBackupController(source);
  await second.restore();
  expect(second.state.connected).toBe(true);
  await second.forgetBrowser();
  expect(second.state.connected).toBe(false);
  expect(
    requests.mock.calls.some(([url]) => String(url).endsWith("/unpair")),
  ).toBe(true);
  second.dispose();
});

test("lost pairing clears a remembered provider without touching local saves", async () => {
  vi.stubGlobal("localStorage", {
    getItem: () =>
      JSON.stringify({
        destination: "github",
        mode: "remembered",
        repository: "gm/backups",
        maxMiB: 512,
      }),
  });
  let paired = true;
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(
      async (input) =>
        new Response(
          JSON.stringify(
            String(input).endsWith("/status")
              ? { paired, available: true, githubConfigured: true }
              : String(input).includes("/list?")
                ? []
                : {},
          ),
          { headers: { "Content-Type": "application/json" } },
        ),
    ),
  );
  const archive = vi.fn(async () => new Blob(["world"]));
  const cloud = new CloudBackupController({
    worldId: "world",
    worldName: "World",
    archive,
  });
  await cloud.restore();
  expect(cloud.state.connected).toBe(true);
  paired = false;
  await cloud.restore();
  expect(cloud.state.connected).toBe(false);
  await expect(cloud.backup()).rejects.toThrow("Connect a backup destination");
  expect(archive).not.toHaveBeenCalled();
  cloud.dispose();
});
