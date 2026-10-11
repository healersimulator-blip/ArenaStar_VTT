import { afterEach, describe, expect, test, vi } from "vitest";
import {
  GoogleDriveAuth,
  validClientId,
} from "../../src/storage/cloud/googleAuth";
import { DRIVE_SCOPE } from "../../src/storage/cloud/googleDrive";

const clientId = "123456-prototype.apps.googleusercontent.com";
interface Response {
  access_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
}
function identity() {
  let callback: (response: Response) => void = () => {};
  let error: () => void = () => {};
  const request = vi.fn();
  vi.stubGlobal("location", { protocol: "https:" });
  vi.stubGlobal("google", {
    accounts: {
      oauth2: {
        initTokenClient(config: {
          client_id: string;
          scope: string;
          include_granted_scopes: boolean;
          callback: typeof callback;
          error_callback: typeof error;
        }) {
          expect(config.client_id).toBe(clientId);
          expect(config.scope).toBe(DRIVE_SCOPE);
          expect(config.include_granted_scopes).toBe(false);
          callback = config.callback;
          error = config.error_callback;
          return { requestAccessToken: request };
        },
      },
    },
  });
  return {
    request,
    respond: (response: Response) => callback(response),
    fail: () => error(),
  };
}
afterEach(() => vi.unstubAllGlobals());

describe("Drive OAuth session boundary", () => {
  test("only a public OAuth client ID is accepted", () => {
    expect(validClientId(clientId)).toBe(true);
    expect(validClientId("a-client-secret")).toBe(false);
    expect(validClientId("https://evil.example/")).toBe(false);
  });
  test("file origins refuse direct authentication", async () => {
    identity();
    vi.stubGlobal("location", { protocol: "file:" });
    await expect(new GoogleDriveAuth().prepare(clientId)).rejects.toThrow(
      "HTTPS",
    );
  });
  test("popup opens synchronously from connect; token remains memory-only and expires", async () => {
    const gis = identity();
    const persist = vi.fn();
    vi.stubGlobal("localStorage", { setItem: persist });
    let now = 1000;
    const auth = new GoogleDriveAuth(() => now);
    await auth.prepare(clientId);
    const signingIn = auth.connect();
    expect(gis.request).toHaveBeenCalledOnce();
    gis.respond({
      access_token: "test-secret",
      expires_in: 60,
      scope: DRIVE_SCOPE,
    });
    await signingIn;
    expect(auth.token()).toBe("test-secret");
    expect(persist).not.toHaveBeenCalled();
    now += 31_000;
    expect(auth.connected).toBe(false);
    expect(() => auth.token()).toThrow("expired");
  });
  test("missing scope/denied consent does not establish a session", async () => {
    const gis = identity();
    const auth = new GoogleDriveAuth();
    await auth.prepare(clientId);
    const connecting = auth.connect();
    gis.respond({
      access_token: "test-secret",
      expires_in: 3600,
      scope: "profile",
    });
    await expect(connecting).rejects.toThrow("not granted");
    expect(auth.connected).toBe(false);
  });
  test("disconnect cancels pending sign-in and ignores late popup callbacks", async () => {
    const gis = identity();
    const auth = new GoogleDriveAuth();
    await auth.prepare(clientId);
    const connecting = auth.connect();
    auth.clear();
    gis.respond({
      access_token: "late-secret",
      expires_in: 3600,
      scope: DRIVE_SCOPE,
    });
    await expect(connecting).rejects.toThrow("cancelled");
    expect(auth.connected).toBe(false);
  });
  test("closed popup is actionable and does not retain a token", async () => {
    const gis = identity();
    const auth = new GoogleDriveAuth();
    await auth.prepare(clientId);
    const connecting = auth.connect();
    gis.fail();
    await expect(connecting).rejects.toThrow("closed or blocked");
    expect(auth.connected).toBe(false);
  });
});
