# Cloud world backups — remembered connections and GitHub

2026-10-10 · D-414 / D-415 · **Implemented prototype; automated mock-provider tests pass. Live Google/GitHub acceptance is still required.**

## What changed

GM **Settings → Saves & backups → Backups & portability → Cloud backups** (also available from Session & world) now provides:

- **Remembered Google Drive connection**, with offline refresh on an optional, same-origin backup companion. Closing a world/tab or restarting the companion does not disconnect the account. Ordinary local play still needs no server.
- **GitHub release-asset backups** in a private repository chosen by the GM. Large binary ZIPs are not repeatedly committed to Git history.
- **GM-configurable ZIP cap**, default **512 MiB**, rather than the old fixed 64 MiB. The setting is device-local and survives browser restarts.
- The existing explicit **Back up now**, verification, recent-backup list, checked downloads and local restore workflow. No per-edit approvals, automatic uploads, pruning or deletion of older backups.

No real cloud account was connected or modified during implementation. You must complete the one-time setup below on your own machine/deployment. An Arena/GitHub connection used for coding is not an account connection inside the shipped VTT.

## Quick start: optional companion

The companion is a small Node service with no additional runtime packages. It serves `dist/index.html` and `/api/cloud/*` on the same origin. It is **single-GM / single-process**, not a multi-tenant account service. Run it on a trusted computer or private server; use your OS service manager to start it automatically if you want backups available whenever you play.

1. Install Node (22 LTS recommended), install the project dependencies and build:

   ```sh
   corepack pnpm install
   corepack pnpm build
   ```

2. For GitHub, install the GitHub CLI (`gh`) and authenticate **once on the companion computer**, under the same OS account that runs it:

   ```sh
   gh auth login --hostname github.com
   ```

   Create or select a **private repository with at least one commit**. The saved login must have Contents write permission. Alternatively, provision `CLOUD_GITHUB_TOKEN` securely in the service environment: a fine-grained token restricted to the chosen repository with Contents read/write is preferable to a broad token. No token field is provided in the world UI. Token expiration/revocation still requires renewing the machine's credential.

3. Run locally:

   ```sh
   corepack pnpm cloud:serve
   ```

   Open **http://localhost:8787** rather than `file://`. **World storage is origin-specific:** preserve your existing app origin when possible. If moving from `file://` or another host, export a local world ZIP there first, import it on the new origin, and verify it before removing the original. Starting the companion does not automatically migrate browser worlds. By default the service binds only to loopback. For a remote deployment put it behind HTTPS and configure:

   ```sh
   CLOUD_PUBLIC_ORIGIN=https://vtt.example.com CLOUD_BIND=0.0.0.0 PORT=8787 corepack pnpm cloud:serve
   ```

   Replace the example origin with your real one. Preserve the original `Host` header through your reverse proxy. Do not expose plain HTTP publicly. Proxy the API and app through the **same origin**, permit large streaming request bodies and allow up to 30 minutes per backup operation. A proxy's default body limit can otherwise reject large ZIPs before they reach the companion. Keep the application's CSP, do not expose the credential directory as static content, and redact OAuth callback query strings and credential-bearing requests from proxy logs. TLS terminates at the reverse proxy; the Node service itself speaks HTTP.

4. On first start the service creates `~/.arenastar-cloud/credentials.json` (or the directory specified by `CLOUD_STATE_DIR`). Its `pairingKey` is the one-time browser-pairing secret. Read **only that field** locally; do not paste the entire file anywhere because it will also contain the Google refresh credential after connection. For the default path:

   ```sh
   node -e 'const fs=require("node:fs"),os=require("node:os"),path=require("node:path"); console.log(JSON.parse(fs.readFileSync(path.join(os.homedir(),".arenastar-cloud","credentials.json"),"utf8")).pairingKey)'
   ```

5. In **Cloud backups**, choose a destination, enter `owner/repository` for GitHub, enter the pairing key, and click **Remember this browser**. The key input is cleared immediately. The browser receives a persistent **HttpOnly, SameSite=Lax cookie** (Secure on HTTPS) valid for 90 days. Subsequent worlds/tabs restore the connection automatically when the companion is running. Clearing cookies, switching browser profiles or cookie expiry requires pairing again, not reauthorizing Google on every session.

For GitHub, the saved machine login and repository are checked, and **Back up now** becomes available. For Google, complete the OAuth setup below once.

### Google offline authorization

Configure these values **on the companion**, never as `VITE_*` secrets or in tracked files:

- `GOOGLE_CLIENT_ID`: your Web application OAuth client ID.
- `GOOGLE_CLIENT_SECRET`: that client's secret.
- `CLOUD_PUBLIC_ORIGIN`: the exact public origin used by the browser.

Enable the Google Drive API and configure OAuth consent/audience. Register the exact redirect URI:

```text
https://YOUR-ORIGIN/api/cloud/google/callback
```

For the local setup, use `http://localhost:8787/api/cloud/google/callback` and Google's supported localhost redirect configuration. Then click **Connect Google Drive**, select the account and consent once. The callback tab can close after completion. The companion requests only `drive.file`, with authorization code + PKCE, state bound to the paired browser, and offline access; it does not ask for blanket Drive access. Short-lived access tokens are renewed automatically and supplied only to the browser's in-memory Drive uploader.

**Google's consent/testing policies still apply.** In particular, an external app left in OAuth Testing can have short-lived refresh grants (commonly seven days for non-basic scopes). Use an appropriate published/internal consent configuration for durable everyday use. Revoked/expired grants require reconnecting; no implementation can bypass provider revocation policies.

Use the same OAuth app on another device to see older app-private Drive metadata. Pair that device with the same companion, or configure its own companion and authorize the same account/app. Changing OAuth apps may hide older app-private metadata while the files remain in Drive for manual download.

### Development / preview

Run the companion with `CLOUD_PUBLIC_ORIGIN` set to the **Vite/browser** origin, then start Vite with:

```sh
CLOUD_DEV_PROXY=http://127.0.0.1:8787 corepack pnpm dev --host 0.0.0.0
```

The proxy is opt-in. Browser requests always use relative `/api/cloud/…` URLs, never the browser's localhost as a remote backend. A changing preview hostname also changes the required origin and Google redirect registration. This environment's outbound network restrictions prevent a live Google/GitHub asset-upload acceptance run; use a normally connected deployment for that gate.

### Static-only fallback

If you do not run a companion, normal local autosave/export remains unchanged. Google offers **Temporary sign-in — static hosting fallback**. This is the original GIS browser-token flow: HTTPS + a public Web OAuth client ID with the app's exact Authorized JavaScript origin, **Enable Google sign-in**, then **Connect Google Drive**. It is explicitly session-only and does **not** pretend that saving an expiring access token would provide persistent authentication. `file://` shows the local-export fallback. GitHub and remembered Google require the companion.

## Size and memory policy

- The GM chooses a whole-number cloud cap from **1–2048 MiB**, default **512 MiB**. **0** removes the *additional cloud-specific cap*, not ZIP security bounds. It does not promise unlimited archives or memory.
- Full-world ZIP import/export guards were raised from 256 MiB compressed / 512 MiB extracted to **1 GiB compressed / 2 GiB extracted** by default. Selecting a custom cap above 1024 MiB raises the compressed guard to that value and the extracted guard to twice that value. This applies to restore on the same device too; on a fresh device set the corresponding limit before opening a larger archive.
- Per-binary-entry limit: **512 MiB**. Tighter JSON/index limits, path validation, entry count and bounded extraction remain in place. ZIP-bomb protections were not removed.
- GitHub transport has a **2 GiB per-asset cap**, independent of the GM's setting. Provider quotas, repository permissions, rate limits, proxy caps and available memory can still limit a backup.
- SHA-256 now hashes 4 MiB slices instead of allocating another whole-ZIP ArrayBuffer. GitHub transport/read-back streams through the companion; Drive uses resumable 4 MiB chunks. **ZIP generation and the final browser download/restore are still memory-backed**, not a new streaming ZIP writer. Large media worlds require substantial RAM; an allocation failure does not indicate a successful backup. Actual >192 MiB media-world browser acceptance remains a live/performance gate, not something established solely by a numeric-limit test.
- The preference is stored in `vtt.cloud.preferences.v2`, outside the world. No credential or cloud retry job is stored there.

## GitHub backup semantics

1. The server checks that the selected repository is private and writable. It never changes repository visibility or creates sharing permissions.
2. Each new snapshot has a UUID-based `arenastar-backup-…` tag and a new **draft release**, with a manifest recording the filename, world-key hash, size and SHA-256.
3. ZIP bytes stream to a release asset. The companion checks the incoming byte count/hash and then the provider asset size/digest. If GitHub supplies no matching SHA-256 digest, it performs a bounded, streaming checked read-back.
4. Only after verification does it publish the release, without making it the repository's latest release. The UI advances its verified timestamp only after the verified response.
5. In-session retry uses the same snapshot ID/bytes, rechecks any existing matching asset and never overwrites a published snapshot. A failed partial asset may require **Start a new snapshot instead**; the unfinished draft is retained for manual inspection. Interrupted transfers are **not byte-resumable** on GitHub. Reload loses the in-memory job, so a later backup starts a new snapshot.
6. No release, tag, asset or older backup is automatically deleted. The list examines the latest 100 repository releases and displays up to 20 recognized, verified backups. Older backups remain accessible through **Open repository releases**. Concurrent uploads of the same snapshot are rejected, not run twice.
7. Downloads use the GitHub asset API. Credentials go only to GitHub's API/upload hosts, never to a redirect CDN. Redirect hosts are allowlisted. The browser rechecks the received ZIP before offering a download.

## Drive / restore / consistency

- Drive uploads are new files in **ArenaStar backups**. In-session retry retains the generated ID and probes the resumable session. Size/SHA verification or checked read-back precedes the verified marker; downloads are always checked again.
- **Download → start screen → Open file → Open as new world** is the recovery path. The cloud panel never replaces the currently open world. Test restore before relying on a destination.
- Cloud preparation first uses local Save now, then the existing media/export-rights-aware world ZIP exporter. Conservative document/activity-stamp checks reject an archive if observed edits occur during collection. This is not a newly atomic all-domain snapshot protocol. Pause realtime simulation and retry between actions if needed.
- Existing export restrictions and missing-blob errors are preserved. Linked media remains a link. World ZIPs include private chat and GM notes and are **not encrypted**. Check Drive sharing and repository collaborators.
- Cloud errors/cancellation do not stop local autosave or introduce per-edit approvals. Failed files/draft releases may remain; no automatic cleanup is performed. Checksums detect corruption, not an attacker able to rewrite both data and its manifest.

## Credential lifecycle and security boundaries

- The companion owns one Google account grant and its OS account's GitHub credential. Its state directory is mode 0700 and vault is 0600 on POSIX; protect the OS account and backups of that directory. This is access-controlled storage, **not an encrypted OS credential vault**. On platforms without POSIX permissions, enforce equivalent filesystem ACLs. Store it outside the repository/world folders and do not run multiple companion processes against the same directory.
- Only hashes of browser session secrets are persisted. Pairing is rate-limited. API mutations require the exact configured Origin and a custom header; Host validation protects against DNS rebinding. There is no permissive CORS. Only serve trusted application code on this origin.
- OAuth uses one-use, expiring, session-bound state + PKCE. Callback query strings contain short-lived authorization codes, not refresh credentials. Tokens/provider response bodies are not logged or copied verbatim into error messages.
- **World close** clears only in-memory jobs/tokens. It does not revoke the saved grant.
- **Forget this browser** removes that browser's companion session. It does not erase the companion's account grants or other paired browsers and does not delete backups.
- **Disconnect Google account** deletes the saved refresh grant and attempts Google revocation. If revocation cannot be confirmed, the panel explicitly tells you to remove the grant in Google account settings. Other paired browsers then need account reconnection too.
- GitHub account logout/rotation is administered on the companion with `gh auth logout` or the configured secret mechanism. To invalidate all pairings, stop the service and clear the vault's sessions; to recover from a leaked pairing key, rotate it too. Removing the entire vault also forgets Google locally but does not itself revoke its remote grant.
- Direct temporary GIS mode retains access tokens only in memory and clears them on disconnect/world close. Refresh tokens, client secrets and long-lived GitHub credentials never enter localStorage, IndexedDB, replicated documents or world ZIPs.

## Validation and remaining gates

Executed for this revision:

- Full Vitest suite: **5268 passed, 12 skipped; 371 files passed, 2 skipped**.
- Targeted cloud/ZIP suite: **47 passed**.
- Node companion integration tests: **6 passed**, with real HTTP transport and mocked upstreams: persistent cookies/refresh across restart, PKCE/state, cancellation/revocation failure, private GitHub upload/publish/retry/read-back and redirect credential isolation.
- Chromium production bundle: **6 passed** (3 cloud scenarios + 3 local-save regressions), including actual ZIP generation, GitHub pairing-cookie reload reconnection, persistent size selection, upload/download and credential exclusion.
- Typecheck/lint/build/size passed. One pre-existing ReplayPanel Svelte advisory; no blocking Svelte issues. Built HTML: **4,886,984 raw bytes / 1,390,309 gzip bytes**, below the 6 MB budget.

**Not executed:** real provider consent/refresh after long idle, real GitHub Release uploads and quotas, >192 MiB media-world export/upload/download/restore on target hardware, cross-device restore, service/proxy restart under an active upload, or Firefox/Safari/mobile acceptance. These remain production release gates. A mocked provider test is not live service certification.

Automatic scheduling, retention/deletion, encrypted ZIPs, history-exclusion/cleanup policy, cross-device merging, streaming ZIP generation and durable upload queues remain separate work. The underlying local-first saving model is unchanged.
