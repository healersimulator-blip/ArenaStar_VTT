# Reliable saves, backups and retention — implementation plan

Date: 2026-10-10. Status: **local-save foundation implemented; Drive/GitHub prototype with remembered auth implemented; production backup/retention/cloud gates remain open**. Companion QoL change: shared scene zoom control.

## Implementation update — quiet local saves (D-413)

The first delivery implements the P0 reliability work and the main P1 local UX:

- Host boot now starts periodic document autosave (the former `start()` was not called there).
- Failed journal entries stay queued in sequence; failed document batches restore dirty roots;
  flush/checkpoint/metadata jobs serialize; watermarks only advance after successful transactions.
- Replayed recovery-log changes are marked dirty, preventing a subsequent flush/restart from losing them.
- Checkpoint reconciliation deletes stale roots and preserves edits received during an in-flight write.
- GM Settings and Session & world share a compact Save now panel. No new approval prompts,
  edit counters, player notifications, or per-save toasts. Only errors produce a persistent retry banner.
- Explicit saves wait for active asynchronous host action/upload/import/package work, strict GM fog
  readback and retained host fog writes, then flush documents. Realtime scenes get a checkpoint.
- Failed close retains the live table for retry. A Web Lock guards same-origin GM world opening where
  available. Normal player permissions are unchanged.
- Existing full ZIP/folder exports are accessible under a collapsed backup section and run local Save now first.

**Not complete P1/P2–P5:** no new per-player durability protocol, all-origin writer-lock fallback,
full multi-domain frozen export snapshot, upload crash-resume, bounded overload mutation blocking,
versioned recovery history, backup-retention presets, live-history cleanup, live cloud acceptance or encryption.
The existing asset upload rejection UI remains authoritative for failed/uncompleted uploads; a local
save receipt covers accepted work, not bytes a player has not yet sent. Lifecycle saving is best-effort,
not a browser unload guarantee. Cross-browser/mobile-device acceptance remains to be run.

The requirements and recommendations below remain the controlling plan for those subsequent slices.

## Historical implementation update — manual Drive prototype (D-414; revised by D-415 below)

The subsequent delivery adds an opt-in Drive section under the collapsed backup panel. It uses
Google Identity Services' session-only token model and `drive.file`, new generated file IDs,
resumable 4 MiB upload chunks, a 64 MiB ZIP limit, SHA-256 verification/read-back fallback,
in-session same-snapshot retry, cancellation, recent backups across worlds and verified downloads.
It does not automatically restore or delete anything. Public OAuth setup is device-local; credentials
and upload-session URLs are memory-only and excluded from world data.

The existing full ZIP exporter runs after Save now, with a conservative activity-stamp check that
rejects observed concurrent edits/imports/fog/simulation activity before upload. This is **not** P2's
full frozen multi-domain snapshot protocol. GIS receives narrow optional CSP allowances and is not
loaded until the GM explicitly enables sign-in setup. Direct OAuth is HTTPS-only in this prototype;
local file play retains the existing ZIP/folder backup controls.

See `CLOUD_BACKUP_PROTOTYPE.md` for configuration, test scope and the live release gate. Actual
Google consent/CORS/account interoperability remains **unverified** in this environment. This is not
completion of P4's real-provider acceptance, P5's GitHub destination, automatic scheduling/retention,
persistent retry queue, history filtering or encryption. No live account was used during development.

## Implementation update — remembered auth, larger worlds and GitHub (D-415)

This revision supersedes D-414's session-only/64 MiB/no-GitHub exclusions:

- Optional same-origin Node companion, explicitly paired once; Google authorization-code + PKCE +
  offline refresh grant held in a protected server-side file, not browser/world storage. Persistent
  HttpOnly cookie remembers a browser for 90 days. World close does not revoke accounts. Saved
  GitHub CLI credentials or a server-configured repository-scoped token stay on the companion.
- GM-selected cloud cap defaults to 512 MiB, supports 1–2048 MiB or 0 for no *extra* cloud cap.
  Independent ZIP guards remain: default 1 GiB compressed / 2 GiB extracted, raised by larger custom
  caps, 512 MiB binary entries and tighter JSON/path/count bounds. Hashing is incremental; ZIP
  generation/restore still needs enough browser RAM. This is not an unlimited streaming ZIP writer.
- Private GitHub repository release assets: new draft per UUID snapshot, checked upload and
  size/digest or read-back verification before publication, in-session idempotent retry, checked
  downloads, no overwrites/pruning, no automatic cleanup of failed drafts. 2 GiB asset cap.
- Direct temporary GIS remains an explicitly labelled static-host fallback. Ordinary local play
  remains serverless and has no additional acceptance prompts.

Evidence: full suite **5268 passed / 12 skipped**, **6 companion integration tests**, **6 Chromium
cloud/local-save cases**, typecheck/lint/build/size passing. `CLOUD_BACKUP_PROTOTYPE.md` is the current
setup and limitation guide. Actual consent/refresh/provider uploads, large-media-world memory and
restore, cross-device operation and non-Chromium/mobile tests remain production gates. P5's GitHub
prototype is now implemented; scheduling/retention/conflicts are not thereby complete.

## 1. Goals and terminology

Preserve every host-accepted GM/player edit and authorized upload, make durability visible, provide a GM Save now command, portable recovery points, optional Drive/GitHub backups, and safe control of history growth. Player permission to create/upload is not permission to export the world or configure its backups.

No browser-only application can promise zero loss after storage eviction, device failure, a sudden process kill before a write finishes, or an unavailable remote service. The UI must expose the difference between:

1. **Local autosave**: durable world data on the GM's current device/origin.
2. **Save now**: explicitly wait for all local persistence domains through a captured save barrier.
3. **Backup**: a consistent, validated world archive on disk or a remote destination.
4. **Retention/cleanup**: explicitly omit history from a backup, or separately delete it from the live world.

Do not call a host's in-memory commit “saved”. Do not silently filter the recovery log. Keep local autosave lossless by default, regardless of backup policy.

## 2. Existing implementation and concrete gaps

| Area | Existing code | Required work |
|---|---|---|
| Documents | `src/storage/persistence.ts`: serialized OpLog writes, ~500 ms document batches, replay on attach | Observable durable sequence/error state; serialized flush/checkpoint/metadata changes; failed-write retry |
| Lifecycle | `src/host/lifecycle.ts`: drain on pagehide/visibility/unload | Best-effort only; browsers do not await unload promises. Add early full-domain barriers, never rely on unload for correctness |
| Assets | `src/host/assets.ts`, `src/storage/opfs.ts`: content-addressed OPFS/IDB storage | Track in-flight ingest, thumbnail/tile jobs and metadata; only mark upload saved after bytes + manifest are durable |
| World ZIP | `src/host/worldFile.ts`: flush, collect docs/assets/packages/fog/strategic data; copy/restore | Stable snapshot boundary across stores; completeness manifest, integrity checks, backup presets |
| Disk | `src/host/worldZip.ts`, existing export and Save to folder UI | Distinguish save from export; atomic/staged folder replacement; permission-loss feedback |
| Player | host intents, projection and upload authorization | Durability acknowledgement/status after host commit; a replica is not a backup |
| Retention | existing action cards, receipts, OpLog, checkpoints and asset usage tools | Typed history policy, dependency analysis, preview and separate destructive cleanup |

Observed reliability hazards (code inspection, not yet failure-injection verified):

- `onEnvelope` chains writes using `.then`; a rejection poisons the chain, so subsequent queued writes never execute. Preserve queued entries and retry in order; never skip a failed sequence.
- `flush()` swaps out dirty roots and updates the cached `flushedSeq` before transaction success. On abort, requeue the captured roots and advance durable metadata only after `tx.done`.
- `checkpoint()`, `flush()` and `patchWorld()` need one serialization boundary. Do not clear new dirty entries or overwrite newer metadata during an awaited checkpoint. Review full-store deletion reconciliation and rollback paths too.
- Archive collection flushes first but reads several domains separately while play can continue. “Flush then export” alone is not a cross-domain snapshot.
- Missing blobs already fail export, and export-rights checks already reject restricted/unreviewed FX media. Preserve those protections.

Local worlds are origin-bound: a different preview hostname, browser profile or opening method can appear to have no worlds. Explain this in recovery UI and offer import, rather than suggesting data was deleted.

## 3. Lessons from other VTTs

**Foundry:** built-in world/package backups, broader snapshots, pre-update backup prompts, and management showing size/compatibility. Its documentation warns that assets outside the backed-up package directories are not included. Adopt explicit scope/completeness reporting and pre-migration recovery points; do not copy its filesystem assumptions into our browser architecture. [1](https://foundryvtt.com/article/backups/)

**Roll20:** game-management documentation offers Pro creators rolling daily save states covering seven days, plus a separate chat archive. Clearing that archive is permanent. Adopt understandable recovery history and clear separation of chat management from restore; improve on destructive cleanup with preview and a recovery point. These are documented service features, not claims about Roll20's internal persistence implementation. [5](https://help.roll20.net/hc/en-us/articles/29620064514071-Game-Details-Page-GM-Only)

Recommendation: continuous local persistence plus named/versioned backups, not a manual-save-only model or a claim that cloud connection replaces local durability.

## 4. Local save coordinator (P0–P1)

Add `src/storage/saveCoordinator.ts` over existing stores; do not introduce a second campaign database.

Suggested status contract:

- `state`: idle / saving / saved / error / storage-unavailable.
- `acceptedSeq`, `durableSeq`, pending upload/job count, last successful local save time.
- Per-domain watermarks for assets, fog, settings/packages and strategic checkpoints; a document sequence alone cannot cover them.
- `saveNow(): Promise<SaveReceipt>` with captured target sequence and domain generations, completed timestamp, warnings and durability scope.

**Barrier semantics:** capture all accepted work when requested. Finish/persist that work; edits accepted later remain pending for the next barrier and cannot falsely inherit the saved status. Pending incomplete player uploads are displayed as uploading, not accepted/saved content. Failed uploads retain retry information where feasible, rather than publishing dangling asset references.

**P0 implementation:** recoverable ordered journal queue; one serialized persistence task queue; transaction-safe dirty bookkeeping; durable sequence only advances after success; structured error notifications; bounded retries with backoff; quota recovery instructions. If saving is blocked, surface a persistent warning and restrict further mutations before memory-only work grows without bound. Never drop operations to recover from quota failures.

**P1 UX:** GM Settings → **Saves & backups**:

- **Save now** (flush local world, not a download).
- Local status/time and pending work; persistent failure banner with Retry and recovery export where possible.
- **Download backup**, existing **Save to folder**, **Cloud backup now**, **Manage backups**.
- Storage estimate/persistence permission status, with a warning that persistent storage is not an off-device backup.

Player status: “Sending”, “Accepted — saving on GM device”, “Saved on GM device”, or “Host save problem”. Use a scoped new protocol durability notification through existing sessions; no secrets or world backup access. Update `PROTOCOL.md` and contract tests. Do not grant players general filesystem/cloud rights. Optional Ctrl/Cmd+S can invoke GM Save now when outside editors; never steal native text-editor shortcuts without an explicit rule.

Close-world waits for a successful barrier or shows an explicit leave-with-unsaved-work choice. Pagehide remains best-effort. Handle mobile suspension, storage denial/private mode, quota exhaustion, multi-tab writers (world lock with fencing/generation), failover and stale host instances.

## 5. Consistent backups and restore (P2)

Reuse the existing world archive format and importer, extending metadata compatibly (version if required). A backup manifest records archive/schema/app/rules versions, world ID, snapshot ID, source sequence/domain watermarks, time, policy, checksums and exclusions.

Snapshot strategy: briefly queue mutating intents and asset finalization; drain accepted work, capture immutable documents/metadata plus pinned content hashes, then release play. Copy/compress/upload outside the mutation barrier. Pin blobs against deletion until the job ends; cancel safely and release pins. Include all world domains, not just documents: fog, packages, stored media, strategic state/checkpoints and settings. Inventory transient vs durable FX/jobs explicitly.

- Validate the snapshot and required references before output. Check exported bytes/checksums; do not replace a last-known-good backup until the new backup is complete.
- External linked media is a dependency, not archived bytes. Offer a separate rights-aware “store linked media” process where feasible; otherwise list URLs as portability warnings.
- Preserve current export-rights gates; cloud is also an export. Never silently bypass or silently omit required restricted assets. A knowingly partial archive must be labeled partial and list omissions.
- Write folder backups as unique files plus a completed manifest (or temp + close + verified promotion where supported). Keep old completed backups after interrupted writes.
- Restore validates schema, hashes, entry limits, ZIP paths/decompression bounds, packages and references before touching the live world. Restore-as-new is the default inspection path. Restore-over-current requires a successful pre-restore backup, confirmation, no connected active writers, and rollback/staging guarantees.
- Add pre-migration and pre-cleanup backups. Local recovery slots alone still share eviction/device risks.

## 6. Save scope and history growth (P3)

Keep **live autosave**, **backup inclusion**, and **live cleanup** as three visibly separate settings.

Initial backup presets:

| Preset | Human public chat/whispers | Rolls/action cards | World state/assets |
|---|---|---|---|
| Save everything (default) | Include | Include | Include |
| Everything except rolls & action cards | Include | Omit eligible completed history | Include |
| Recent mechanics history | Include | Keep last N days or N cards | Include |
| No chat history (advanced) | Omit eligible history | Omit eligible history | Include |

Human emotes/OOC/whispers remain chat. Preserve their existing permissions; “keep chat” must not turn whispers public. Classify using typed `MessageDocument.roll` and `actionCardOf(message)`/system metadata, not text matching. Inventory generated system/audit messages; keep unknown legacy messages conservatively. Add timestamps/classification migrations where absent, with a tested fallback for old worlds.

**Critical dependency:** action cards may be active workflow state, condition provenance, rider references or Revert dependencies. Removing a card must not remove the HP change, condition, inventory change or other resolved mechanics it caused. Build a reference graph covering pending saves/casts, condition applications, action receipts, undo/revert, automation and links. Pin pending/dependent records or compact their required state into dedicated durable records before omission. Show retained dependency counts. Never claim “all cards omitted” if some must remain.

Backup filtering transforms a snapshot only. Preview counts and estimated bytes per category; disclose changes to historical Revert/undo availability. On restore, do not replay excluded history from an included OpLog. Use a materialized snapshot at a new recovery baseline, with retained mechanics and validated refs. Keep active workflow state intact. Historical backwards compatibility tests are required.

**Live cleanup** is separate and GM-only: preview → successful pre-cleanup backup → confirmation → host-authorized deletion/compaction. Preserve a configurable undo/revert horizon. Compact durable log entries only after a valid checkpoint; consider lagging peers (snapshot fallback), replay/checkpoint dependencies and receipts. Do not filter or prune active crash-recovery writes.

Media often dominates size: show documents, human chat, cards, OpLog, fog, strategic replays, packages, media/variants and backup bytes separately. Unreferenced-media cleanup must use a complete reference traversal including Codex, FX, compendia, archived/checkpoint states and in-flight jobs. Unknown references block deletion; a failed reachability scan never means “unused”. No automatic deletion of uploaded art by default.

## 7. Cloud design (P4–P5)

Cloud saves are **versioned backups**, not multiplayer authority or live bidirectional sync. Only the GM configures them. Private destination by default; warn that archives contain GM secrets and private chat. Application credentials must never enter replicated settings, world ZIPs, chat, source control or logs. Arena's connected-app authorization is not authorization for users of the shipped VTT.

Provider interface: connect/disconnect, capability/limit check, list backups, upload snapshot with progress/cancel, verify, download, explicitly delete. Keep provider IDs/config local to the GM device; use opaque IDs returned by the provider. Queue immutable jobs with stable IDs and checksums; retries cannot create infinite duplicate backups. Exponential backoff for offline/429/5xx; expired auth requires reconnect. No successful cloud status until upload and verification complete.

### Google Drive — recommended primary destination

Use a configured OAuth public-client integration over a stable HTTPS origin, minimal `drive.file` access to app-created/selected files, and resumable uploads. Drive documents resumable upload sessions and the file-scoped permission option. [1](https://developers.google.com/workspace/drive/api/guides/manage-uploads) [3](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/create)

Do an authentication/CORS proof-of-concept before committing to the UX: provider consent configuration, redirect/authorized origin, session expiry and current CSP must be tested. Do not embed a client secret or persist a long-lived token in world storage. Prefer short-lived in-memory access tokens; any persistent credential support requires a secure platform/companion design. `file://` and changing preview hosts must not be advertised as direct OAuth-capable without validation. A downloaded ZIP or approved local companion remains the fallback.

Upload a new versioned ZIP per recovery point; verify its size/provider checksum and our own manifest before making it “latest”. Avoid blind overwrites. List explicit backup IDs rather than relying on provider revision retention. Delete older completed backups only after a new verified one exists and within a policy limited to this world's managed files.

### GitHub — optional repository-backed destination

Do not repeatedly commit full binary world ZIPs to Git history: GitHub blocks ordinary Git files over 100 MiB and recommends Releases for distributing larger binaries. [1](https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-large-files-on-github)

Proposed implementation: a **dedicated private backup repository**, immutable snapshot IDs, and ZIP assets attached to releases (not source commits). Check current release/API size limits, account quotas, upload-host CORS and terms during the provider spike; do not hard-code an assumed unlimited size. Reject oversize before upload. Git contents mode is an optional future small-manifest/deduplicated-data design, not the default.

Authentication: least-privilege repository-scoped GitHub App/OAuth or an opt-in local companion that owns credentials. Browser-only token exchange, CORS and `file://` support must be proven; if unsupported, do not ship a nonworking direct browser button. Do not ask users to paste long-lived tokens into campaign documents. The companion must be explicitly installed, paired and authenticated; no new mandatory server for ordinary VTT use.

### Scheduling and conflicts

Proposed defaults (configurable): local autosave always on; cloud disabled until configured; then backup on dirty state every 15 minutes and offer a session-end backup. One job per world/destination; coalesce new edits into the next job. Offline jobs remain pending and visible; bounded queue with warning, never silently claim uploaded. No guarantee of background uploads after the tab closes.

Each device has an identity and records the remote base snapshot it observed. A changed remote head produces a conflict prompt, never last-writer-wins. Offer download/open-as-new, keep both, or explicit replacement after backup; no automatic document merge. Retention proposal: last 10 successful backups plus daily 7/weekly 4 recovery points, user-configurable and quota-aware. Failed uploads never trigger pruning.

Optional archive encryption should be a separate reviewed feature with authenticated encryption, a versioned envelope and a recovery-key UX. Explain that lost keys cannot be recovered; do not improvise cryptography in the first provider slice.

## 8. Delivery sequence and acceptance gates

| Phase | Deliverable | Required evidence |
|---|---|---|
| P0 | Ordered, recoverable persistence queue and storage status | Inject failed log/document writes, quota errors, interrupted checkpoints, concurrent metadata updates; exact reload recovery with no skipped sequences |
| P1 | Full-domain Save now + GM/player status + writer lock | Save/reload edited scenes, journals/Codex, actors, items, FX, player uploads, fog, rules/packages and strategic state; player cannot export/configure; two-tab stale-writer rejection |
| P2 | Consistent versioned local ZIP/folder backups + safe restore | Editing/uploading during export; missing/restricted media; snapshot hash validation; corrupt ZIP rejection; interrupted restore preserves previous world; copy vs replace |
| P3 | History presets and preview, then separate cleanup | Plain/whisper chat retained; old roll/card omissions do not change mechanics; pending cards survive; no dangling refs; clean restart cannot resurrect pruned messages; byte accounting |
| P4 | Provider capability/auth spikes, then Drive | Real stable HTTPS login + denied/expired auth, resumable interruption, hash verification, offline retry, restore on fresh browser; `file://` fallback tested |
| P5 | GitHub destination, scheduling/retention/conflicts | Private repo confirmation, provider size limit, rate limits, duplicate retry, two-device conflict, backup restore, no leaked secrets; prune only after verified success |

Each phase: targeted Vitest + browser tests, protocol contract coverage where changed, lint/typecheck, production build and ≤6 MB budget. Gate Google/GitHub delivery on actual provider tests outside restricted environments; mocks are necessary but not sufficient. Cross-browser/mobile tests must cover storage API differences and lifecycle behavior.

## 9. Decisions recommended for approval before save implementation

1. Local autosave remains lossless; exclusion presets initially affect backups only. Live cleanup requires a separate confirmation.
2. Drive is the first cloud provider; GitHub uses private repository release assets rather than ZIP commits.
3. Direct OAuth requires a supported stable HTTPS deployment; portable `file://` keeps disk backups and may use an optional paired companion.
4. Pin cards required by live mechanics until safe compaction exists; report these exceptions rather than breaking state to achieve a smaller save.
5. First implementation slice is P0 + P1, not cloud UI. Do not show “Saved” until durability is verified.
