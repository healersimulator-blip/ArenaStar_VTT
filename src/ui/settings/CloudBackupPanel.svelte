<script lang="ts">
  import { onMount } from "svelte";
  import type {
    CloudBackupController,
    CloudBackupState,
  } from "../../storage/cloud/cloudBackup";
  import { loadCloudPreferences } from "../../storage/cloud/preferences";
  import { driveOriginSupported } from "../../storage/cloud/googleAuth";

  let { cloud }: { cloud: CloudBackupController } = $props();
  let state = $state<CloudBackupState | null>(null);
  let clientId = $state("");
  let pairingKey = $state("");
  let preferences = $state(loadCloudPreferences());
  const remembered = $derived(
    preferences.mode === "remembered" || preferences.destination === "github",
  );
  let supported = $state(false);
  let origin = $state("");
  const key = "vtt.googleDrive.oauthClientId"; // Public deployment ID only. Never tokens or world data.
  const busy = $derived(state !== null && state.phase !== "idle");
  onMount(() => {
    supported = driveOriginSupported();
    origin = location.origin;
    try {
      clientId =
        localStorage.getItem(key) ??
        import.meta.env.VITE_GOOGLE_DRIVE_CLIENT_ID ??
        "";
    } catch {
      clientId = import.meta.env.VITE_GOOGLE_DRIVE_CLIENT_ID ?? "";
    }
    return cloud.subscribe((next) => {
      state = next;
      preferences = { ...next.preferences };
    });
  });
  async function prepare() {
    try {
      await cloud.prepare(clientId);
      try {
        localStorage.setItem(key, clientId.trim());
      } catch {
        /* Memory-only setup still works. */
      }
    } catch {
      /* Shared controller renders the single contextual error. */
    }
  }
  async function download(id: string) {
    try {
      const { blob, backup } = await cloud.download(id);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download =
        (backup.name
          .replace(/[^\p{L}\p{N} ._-]/gu, "_")
          .replace(/\.zip$/i, "") || "world-backup") + ".zip";
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch {
      /* Shared status, no toast or modal. */
    }
  }
  const phases = {
    idle: "",
    setup: "Loading sign-in…",
    "sign-in": "Connecting backup destination…",
    preparing: "Preparing world backup…",
    uploading: "Uploading…",
    verifying: "Verifying backup…",
    listing: "Reading backups…",
    downloading: "Downloading and verifying…",
  };
</script>

<details class="cloud" data-cloud-backup>
  <summary>Cloud backups <small>Optional</small></summary>
  <p>
    Manual, separate recovery copies. No automatic uploads, overwrites or
    history deletion. Google Drive or a private GitHub repository.
  </p>
  <label
    >Destination
    <select
      aria-label="Backup destination"
      bind:value={preferences.destination}
      disabled={busy}
      onchange={() => {
        cloud.configure(preferences);
        void cloud.restore();
      }}
    >
      <option value="google">Google Drive</option>
      <option value="github">GitHub release assets (private repository)</option>
    </select>
  </label>
  {#if preferences.destination === "google"}
    <label
      >Connection
      <select
        aria-label="Backup connection"
        bind:value={preferences.mode}
        disabled={busy}
        onchange={() => {
          cloud.configure(preferences);
          void cloud.restore();
        }}
      >
        <option value="remembered">Remember across sessions — companion</option>
        <option value="temporary"
          >Temporary sign-in — static hosting fallback</option
        >
      </select>
    </label>
  {:else}
    <label
      >Private repository (owner/name)
      <input
        aria-label="GitHub backup repository"
        bind:value={preferences.repository}
        disabled={busy}
        placeholder="your-account/world-backups"
        onchange={() => {
          cloud.configure(preferences);
          void cloud.restore();
        }}
      />
    </label>
    <p class="hint">
      ZIPs are release assets, not Git commits. The companion uses its saved
      GitHub CLI login or a configured token with Contents write permission.
      Start with a private repository containing an initial commit.
    </p>
  {/if}
  <label
    >Maximum backup ZIP size (MiB)
    <input
      aria-label="Maximum backup ZIP size (MiB)"
      type="number"
      min="0"
      max="2048"
      step="1"
      bind:value={preferences.maxMiB}
      disabled={busy}
      onchange={() => cloud.configure(preferences)}
    />
  </label>
  <p class="hint">
    Default: 512 MiB. Set 0 for no additional cloud cap. ZIP safety bounds
    remain: at least 1 GiB compressed / 2 GiB extracted, raised with a larger
    custom limit; 512 MiB per media file. GitHub assets are capped at 2 GiB.
    Large worlds still require sufficient browser memory.
  </p>
  {#if remembered}
    <p class="hint">
      One-time companion setup: CLOUD_BACKUP_PROTOTYPE.md. Google’s offline
      credential and GitHub credentials stay on the companion, not in world
      files or browser storage. The browser is remembered for 90 days; clearing
      cookies requires pairing again.
    </p>
    {#if !state?.companion?.paired}
      <label
        >Companion pairing key
        <input
          aria-label="Companion pairing key"
          type="password"
          autocomplete="off"
          bind:value={pairingKey}
          disabled={busy}
        />
      </label>
      <button
        type="button"
        disabled={busy || !pairingKey.trim()}
        onclick={() => {
          const key = pairingKey;
          pairingKey = "";
          void cloud.pair(key).catch(() => undefined);
        }}>Remember this browser</button
      >
    {:else}
      <p>
        Browser paired. {preferences.destination === "google"
          ? state.companion.googleConfigured
            ? "Google OAuth is configured."
            : "Configure Google OAuth on the companion first."
          : state.companion.githubConfigured
            ? "Saved GitHub login found."
            : "Run gh auth login on the companion first."}
      </p>
      <button
        type="button"
        disabled={busy}
        onclick={() => {
          void cloud.forgetBrowser().catch(() => undefined);
        }}>Forget this browser</button
      >
    {/if}
    <button
      type="button"
      disabled={busy}
      onclick={() => {
        void cloud.restore();
      }}>Check remembered connection</button
    >
  {/if}
  {#if !remembered && !supported}
    <p>
      Google sign-in needs a registered HTTPS address. Serve this app over HTTPS
      to connect; Download world backup still works here.
    </p>
  {:else}
    {#if !remembered && !state?.ready}
      <div class="setup">
        <p>
          One-time deployment setup: enable the Google Drive API and create a
          Google OAuth <strong>Web application</strong> client. Register this JavaScript
          origin:
        </p>
        <code>{origin}</code>
        <label
          >OAuth client ID (public, not a secret)
          <input
            aria-label="Google OAuth client ID"
            type="text"
            autocomplete="off"
            spellcheck="false"
            bind:value={clientId}
            disabled={busy}
            placeholder="…apps.googleusercontent.com"
          />
        </label>
        <button
          type="button"
          disabled={busy || !clientId.trim()}
          onclick={prepare}>Enable Google sign-in</button
        >
        <p class="hint">
          This loads Google’s sign-in library. The deployment owner configures
          consent/test users. Setup instructions: CLOUD_BACKUP_PROTOTYPE.md in
          the project.
        </p>
      </div>
    {/if}
    <p class="privacy">
      World ZIPs contain GM notes and private chat. Check repository or folder
      access. ArenaStar does not encrypt these files. Remembered connections
      survive world close; temporary Google tokens do not.
    </p>
    <div class="actions">
      {#if !state?.connected}
        <button
          type="button"
          disabled={busy || !state?.ready}
          onclick={() => {
            void cloud.connect().catch(() => undefined);
          }}
          >{preferences.destination === "github"
            ? "Connect GitHub repository"
            : "Connect Google Drive"}</button
        >
      {:else}
        <button
          type="button"
          disabled={busy}
          onclick={() => {
            void cloud.backup().catch(() => undefined);
          }}>{state.canRetry ? "Retry backup" : "Back up now"}</button
        >
        <button
          type="button"
          disabled={busy}
          onclick={() => {
            void cloud.refresh().catch(() => undefined);
          }}>Refresh list</button
        >
      {/if}
      {#if !remembered && (state?.connected || state?.phase === "sign-in")}
        <button type="button" onclick={() => cloud.disconnect()}
          >Disconnect</button
        >
      {:else if remembered && state?.connected && preferences.destination === "google"}
        <button
          type="button"
          disabled={busy}
          onclick={() => {
            void cloud.forgetGoogle().catch(() => undefined);
          }}>Disconnect Google account</button
        >
      {/if}
      {#if busy}<button type="button" onclick={() => cloud.cancel()}
          >Cancel</button
        >{/if}
    </div>
    {#if state?.canRetry}<p class="hint">
        Retry continues the same snapshot, not newer edits. An unfinished file
        or draft release may remain.
        <button
          type="button"
          disabled={busy}
          onclick={() => cloud.abandonRetry()}
          >Start a new snapshot instead</button
        >
      </p>{/if}
    {#if state?.lastVerifiedAt}<p>
        Last verified backup: {new Date(state.lastVerifiedAt).toLocaleString()}
      </p>{/if}
    {#if busy}
      <p role="status">{phases[state?.phase ?? "idle"]}</p>
      {#if state?.phase === "uploading"}<progress
          max="1"
          value={state.progress}
          aria-label="Backup upload progress"
        ></progress>{/if}
    {/if}
    {#if state?.error}<p role="alert" class="error">{state.error}</p>{/if}
    {#if state?.notice}<p role="status">{state.notice}</p>{/if}
    {#if state?.folderUrl}<a
        href={state.folderUrl}
        target="_blank"
        rel="noopener noreferrer"
        >Open {preferences.destination === "github"
          ? "repository releases"
          : "backup folder in Drive"} ↗</a
      >{/if}
    {#if state?.connected}
      <h4>Recent backups — all worlds</h4>
      <p class="hint">
        Up to 20 recent supported backups. Downloads are checksum-checked;
        restore from the start screen with Open file → Open as new world.
        Nothing here replaces the live world.
      </p>
      {#if state.backups.length === 0}<p>
          No supported backups found yet.
        </p>{/if}
      <ul>
        {#each state.backups as backup (backup.id)}
          <li>
            <div>
              <strong>{backup.name}</strong><br /><small
                >{(backup.size / 1048576).toFixed(2)} MiB · {backup.verified
                  ? "Verified upload"
                  : "Unverified upload"}</small
              >
            </div>
            <button
              type="button"
              disabled={busy}
              onclick={() => download(backup.id)}
              aria-label={`Download ${backup.name}`}>Download</button
            >
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
</details>

<style>
  .cloud {
    border-top: 1px solid #465466;
    margin-top: 12px;
    padding-top: 8px;
  }
  summary {
    cursor: pointer;
    padding: 8px 0;
    font-weight: 600;
  }
  summary small {
    font-weight: normal;
    color: #e9c780;
    margin-left: 8px;
  }
  p {
    line-height: 1.45;
    margin: 8px 0;
  }
  .hint,
  small {
    color: #bac8d8;
    font-size: 0.85rem;
  }
  .privacy {
    border-left: 2px solid #8b7440;
    padding-left: 8px;
  }
  .actions {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }
  button {
    padding: 8px 12px;
    min-height: 40px;
    cursor: pointer;
  }
  button:disabled {
    cursor: default;
    opacity: 0.6;
  }
  label {
    display: grid;
    gap: 6px;
    margin: 12px 0;
  }
  input,
  select {
    box-sizing: border-box;
    width: 100%;
    min-height: 40px;
    padding: 8px;
  }
  code {
    display: block;
    overflow-wrap: anywhere;
    user-select: all;
  }
  .error {
    color: #ffb9b9;
  }
  a {
    color: #9dc7ff;
  }
  ul {
    list-style: none;
    padding: 0;
  }
  li {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 10px 0;
    border-top: 1px solid #465466;
  }
  li div {
    min-width: 0;
    overflow-wrap: anywhere;
  }
  progress {
    width: 100%;
  }
</style>
