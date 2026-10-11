/** Google Identity Services is loaded only after the GM explicitly enables Drive setup. */
import { DRIVE_SCOPE, DriveError } from "./googleDrive";

interface TokenResponse {
  access_token?: string;
  expires_in?: number | string;
  scope?: string;
  error?: string;
}
interface TokenClient {
  requestAccessToken(options?: { prompt?: string }): void;
}
interface GoogleIdentity {
  accounts: {
    oauth2: {
      initTokenClient(config: {
        client_id: string;
        scope: string;
        include_granted_scopes: boolean;
        callback: (response: TokenResponse) => void;
        error_callback: () => void;
      }): TokenClient;
    };
  };
}
const identity = (): GoogleIdentity | undefined =>
  (globalThis as typeof globalThis & { google?: GoogleIdentity }).google;
let loading: Promise<GoogleIdentity> | null = null;
export const validClientId = (id: string): boolean =>
  /^\d+-[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(id);
export function driveOriginSupported(): boolean {
  return (
    globalThis.location?.protocol === "https:" && !!globalThis.crypto?.subtle
  );
}
function loadIdentity(): Promise<GoogleIdentity> {
  const existing = identity();
  if (existing?.accounts?.oauth2) return Promise.resolve(existing);
  if (loading) return loading;
  loading = new Promise<GoogleIdentity>((resolve, reject) => {
    const script = document.createElement("script");
    let finished = false;
    const fail = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      script.remove();
      reject(
        new DriveError(
          "Google sign-in could not load. Check the connection or content blocker, then retry setup.",
        ),
      );
    };
    const timer = setTimeout(fail, 20_000);
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.referrerPolicy = "no-referrer";
    script.onerror = fail;
    script.onload = () => {
      const google = identity();
      if (!google?.accounts?.oauth2) {
        fail();
        return;
      }
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve(google);
    };
    document.head.append(script);
  }).catch((error) => {
    loading = null;
    throw error;
  });
  return loading;
}

export class GoogleDriveAuth {
  private google: GoogleIdentity | null = null;
  private clientId = "";
  private accessToken = "";
  private expiresAt = 0;
  private generation = 0;
  private cancelSignIn: (() => void) | null = null;
  constructor(private readonly now: () => number = Date.now) {}
  get connected(): boolean {
    return !!this.accessToken && this.now() < this.expiresAt;
  }
  token(): string {
    if (!this.connected) {
      this.accessToken = "";
      throw new DriveError(
        "Google sign-in expired. Connect Google Drive again.",
        401,
      );
    }
    return this.accessToken;
  }
  async prepare(clientId: string): Promise<void> {
    if (!driveOriginSupported())
      throw new DriveError(
        "Direct Google Drive sign-in requires this app on a registered HTTPS origin. Local ZIP backups still work here.",
      );
    if (!validClientId(clientId))
      throw new DriveError(
        "Enter a Google OAuth Web application client ID, not a client secret.",
      );
    this.google = await loadIdentity();
    this.clientId = clientId;
  }
  /** Call directly from a click; no awaited SDK load before opening the OAuth popup. */
  connect(): Promise<void> {
    const google = this.google;
    if (!google || !this.clientId)
      return Promise.reject(new DriveError("Finish Drive setup first."));
    this.clear();
    const generation = this.generation;
    return new Promise<void>((resolve, reject) => {
      let done = false;
      const finish = (error?: Error) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.cancelSignIn = null;
        if (error) reject(error);
        else resolve();
      };
      const timer = setTimeout(
        () =>
          finish(
            new DriveError("Google sign-in timed out. Try connecting again."),
          ),
        120_000,
      );
      this.cancelSignIn = () =>
        finish(new DriveError("Google sign-in cancelled."));
      try {
        const client = google.accounts.oauth2.initTokenClient({
          client_id: this.clientId,
          scope: DRIVE_SCOPE,
          include_granted_scopes: false,
          callback: (response) => {
            if (done || generation !== this.generation) return;
            const expires = Number(response.expires_in);
            if (
              response.error ||
              !response.access_token ||
              !Number.isFinite(expires) ||
              expires <= 30 ||
              !response.scope?.split(" ").includes(DRIVE_SCOPE)
            ) {
              finish(
                new DriveError(
                  "Drive access was not granted. Local saving is unaffected.",
                ),
              );
              return;
            }
            this.accessToken = response.access_token;
            this.expiresAt = this.now() + Math.min(expires - 30, 86400) * 1000;
            finish();
          },
          error_callback: () =>
            finish(
              new DriveError(
                "Google sign-in was closed or blocked. Allow the popup and try again.",
              ),
            ),
        });
        client.requestAccessToken({ prompt: "select_account" });
      } catch {
        finish(
          new DriveError(
            "Could not open Google sign-in. Try connecting again.",
          ),
        );
      }
    });
  }
  /** Disconnect locally. It does not delete backups or revoke the app's account grant. */
  clear(): void {
    this.generation++;
    this.cancelSignIn?.();
    this.cancelSignIn = null;
    this.accessToken = "";
    this.expiresAt = 0;
  }
}
