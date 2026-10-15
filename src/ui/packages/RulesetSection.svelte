<script lang="ts">
  import type { AisModuleSettingsView, AisModuleShellApi, AisRuntimeStatuses } from "../../app/aisRuntime";
  import type { AisModuleDiagnostics } from "../../packages/aisHealth";
  import type { AisSettingValue } from "../../core/automationInterconnect";
  import AisSettingsForm from "./AisSettingsForm.svelte";
  /**
   * §12 the packages view (AIS v1 lands modules next to the ruleset/content view; D-248/D-249).
   * Lives in the Settings window: "which rules does this world run" is a settings question,
   * not an Extras one. The primary way to choose a ruleset is the New-world wizard; this
   * section is for the status line, adding content packs mid-campaign (they never touch the
   * sim), the fresh-campaign ruleset switch (activate → reload), and the D-089 trust consent.
   *
   * Scope, said on screen too: the ruleset drives strategic-scale scenes (heroes + units);
   * tactical scenes (heroes only) are unaffected, so one world mixes both.
   */
  import { onDestroy, onMount } from "svelte";
  import type { HostAutomationState, HostPackages, HostRulesBoot, PackageSummary } from "../../app/hostBoot";
  import type { AisCapability } from "../../core/automationInterconnect";
  import { classifyZip, packageKindLabel } from "../../host/zipKind";
  import { firstPartyPackageBytes, firstPartyPackages } from "../../app/firstPartyPackages";

  let {
    packages,
    rulesBoot = null,
    aisRuntimeStatuses = {},
    onOpenAisPanel = null,
    aisModules = null,
  }: {
    packages: HostPackages;
    rulesBoot?: HostRulesBoot | null;
    aisRuntimeStatuses?: AisRuntimeStatuses;
    onOpenAisPanel?: ((packageId: string) => void) | null;
    /** D-476/D-479: settings form + health block of running modules (null before the world boots). */
    aisModules?: AisModuleShellApi | null;
  } = $props();

  // D-476: settings views load lazily when the GM expands a module's settings block.
  let aisSettingsViews = $state<Record<string, AisModuleSettingsView>>({});
  // D-479: health snapshots refresh when the block is expanded or after an action.
  let aisHealthViews = $state<Record<string, AisModuleDiagnostics | null>>({});
  let aisHealthNotice = $state<Record<string, string>>({});

  async function loadAisSettings(id: string): Promise<void> {
    if (!aisModules) return;
    const view = await aisModules.settings(id);
    if (view) aisSettingsViews = { ...aisSettingsViews, [id]: view };
  }

  async function writeAisSetting(id: string, key: string, value: AisSettingValue): Promise<void> {
    if (!aisModules) throw new Error("The world has not booted yet.");
    await aisModules.setSetting(id, key, value);
    await loadAisSettings(id);
  }

  function refreshAisHealth(id: string): void {
    aisHealthViews = { ...aisHealthViews, [id]: aisModules?.diagnostics(id) ?? null };
  }

  async function restartAisModule(id: string): Promise<void> {
    if (!aisModules) return;
    const restarted = await aisModules.restart(id);
    aisHealthNotice = { ...aisHealthNotice, [id]: restarted ? "Restarted from the approved boot definition." : "Not restartable here (not booted, or an adapter/appearance module)." };
    refreshAisHealth(id);
  }

  const traceTime = (at: number): string => new Date(at).toLocaleTimeString();

  let pkgList = $state<PackageSummary[]>([]);
  let aisState = $state<HostAutomationState | null>(null);
  let selectedCapabilities = $state<Record<string, AisCapability[]>>({});
  let aisApprovalConfirmId = $state("");
  let aisApprovalTimer: ReturnType<typeof setTimeout> | null = null;
  let aisCodePreviews = $state<Record<string, { entry: string; source: string; truncated: boolean; hash: string; runtimeHash?: string }>>({});
  let aisPreviewLoadingId = $state("");
  let aisPendingReload = $state(false);
  let pkgBusy = $state(false);
  let pkgError = $state("");
  /** Name of the ruleset activated this session — it runs after the next world reload. */
  let pkgPendingReload = $state("");
  /** Advisory notes from the last activation (missing declared companions, D-110). */
  let pkgWarnings = $state<string[]>([]);
  /** A turn has been resolved somewhere: the ruleset is pinned (activate would refuse). */
  let pinned = $state(false);
  let pkgFileInput = $state<HTMLInputElement | null>(null);

  const active = $derived(pkgList.find((p) => p.active) ?? null);
  const contentPacks = $derived(pkgList.filter((p) => p.type === "data"));
  const automationModules = $derived(pkgList.filter((p) => p.type === "module"));
  const packTotal = $derived(contentPacks.reduce((n, p) => n + p.packCount, 0));

  const refresh = (): void => {
    void packages
      .list()
      .then((list) => {
        const changed = new Set(list.filter((entry) => pkgList.some((previous) =>
          previous.id === entry.id && (previous.hash !== entry.hash || previous.runtimeHash !== entry.runtimeHash))).map((entry) => entry.id));
        aisCodePreviews = Object.fromEntries(Object.entries(aisCodePreviews).filter(([id, preview]) =>
          list.some((entry) => entry.id === id && entry.hash === preview.hash && entry.runtimeHash === preview.runtimeHash)));
        selectedCapabilities = Object.fromEntries(Object.entries(selectedCapabilities).filter(([id]) => !changed.has(id)));
        if (changed.has(aisApprovalConfirmId)) aisApprovalConfirmId = "";
        pkgList = list;
      })
      .catch(() => {});
    void packages.automation().then((state) => { aisState = state; }).catch(() => {});
    void packages
      .campaignStarted()
      .then((started) => {
        pinned = started;
      })
      .catch(() => {});
  };

  async function importPackageZip(): Promise<void> {
    if (!pkgFileInput?.files?.[0]) return;
    pkgBusy = true;
    pkgError = "";
    try {
      const bytes = new Uint8Array(await pkgFileInput.files[0].arrayBuffer());
      // D-248: a world file dropped here is named, not failed with "manifest.json missing".
      const kind = await classifyZip(bytes);
      if (kind.kind === "world") {
        pkgError = `"${kind.name}" is a world file, not a ruleset or content pack — close this world and use Open file (.zip) on the start screen.`;
        return;
      }
      if (kind.kind === "unknown") {
        pkgError = kind.reason;
        return;
      }
      const res = await packages.importZip(bytes);
      if (!res.ok) pkgError = res.error;
      else if (res.summary.type === "module" || res.summary.type === "system") aisPendingReload = true;
      refresh();
    } finally {
      // let the same file be picked again after a fix
      if (pkgFileInput) pkgFileInput.value = "";
      pkgBusy = false;
    }
  }

  /**
   * D-473: the packages this build ships (PF1e Mass Battles + Pathfinder 1e Core) can be added to
   * an existing world without a file — the same `importZip` path, the same activate-then-reload
   * step afterwards. Hidden once every first-party package is present.
   */
  const firstPartyMissing = $derived(firstPartyPackages().filter((entry) => !pkgList.some((p) => p.id === entry.id)));
  async function installFirstParty(): Promise<void> {
    pkgBusy = true;
    pkgError = "";
    try {
      for (const entry of firstPartyMissing) {
        const res = await packages.importZip(firstPartyPackageBytes(entry));
        if (!res.ok) { pkgError = `${entry.name}: ${res.error}`; break; }
        if (res.summary.type === "module" || res.summary.type === "system") aisPendingReload = true;
      }
      refresh();
    } finally {
      pkgBusy = false;
    }
  }

  async function activatePackage(id: string): Promise<void> {
    pkgBusy = true;
    pkgError = "";
    pkgWarnings = [];
    try {
      const res = await packages.activate(id);
      if (!res.ok) pkgError = res.error;
      else {
        pkgWarnings = res.warnings ?? [];
        pkgPendingReload = pkgList.find((p) => p.id === id)?.name ?? id;
      }
      refresh();
    } finally {
      pkgBusy = false;
    }
  }

  async function enableAutomationModule(id: string): Promise<void> {
    pkgBusy = true;
    pkgError = "";
    try {
      const result = await packages.enableAutomationModule(id);
      if (!result.ok) pkgError = result.error;
      else aisPendingReload = true;
      refresh();
    } finally {
      pkgBusy = false;
    }
  }

  async function disableAutomationModule(id: string): Promise<void> {
    pkgBusy = true;
    pkgError = "";
    try {
      const result = await packages.disableAutomationModule(id);
      if (!result.ok) pkgError = result.error;
      else aisPendingReload = true;
      refresh();
    } finally {
      pkgBusy = false;
    }
  }

  async function selectAutomationProvider(slotId: string, providerRef: string): Promise<void> {
    if (!providerRef) return;
    pkgBusy = true;
    pkgError = "";
    try {
      const result = await packages.selectAutomationProvider(slotId, providerRef);
      if (!result.ok) pkgError = result.error;
      else aisPendingReload = true;
      refresh();
    } finally {
      pkgBusy = false;
    }
  }

  function capabilitiesFor(id: string, summary: PackageSummary): AisCapability[] {
    return selectedCapabilities[id] ?? summary.grantedCapabilities;
  }

  function toggleCapability(id: string, summary: PackageSummary, capability: AisCapability, checked: boolean): void {
    const current = capabilitiesFor(id, summary);
    const selected = checked
      ? current.includes(capability) ? current : [...current, capability]
      : current.filter((entry) => entry !== capability);
    selectedCapabilities = { ...selectedCapabilities, [id]: selected };
  }

  async function loadAisCodePreview(id: string): Promise<void> {
    if (aisCodePreviews[id] || aisPreviewLoadingId) return;
    aisPreviewLoadingId = id;
    pkgError = "";
    try {
      const result = await packages.previewAutomationModule(id);
      if (!result.ok) pkgError = result.error;
      else aisCodePreviews = { ...aisCodePreviews, [id]: result };
    } finally {
      aisPreviewLoadingId = "";
    }
  }

  function requestAisApproval(id: string, summary: PackageSummary): void {
    if (aisApprovalConfirmId !== id) {
      aisApprovalConfirmId = id;
      if (aisApprovalTimer !== null) clearTimeout(aisApprovalTimer);
      aisApprovalTimer = setTimeout(() => { aisApprovalConfirmId = ""; }, 4_000);
      if (!aisCodePreviews[id]) void loadAisCodePreview(id);
      return;
    }
    const preview = aisCodePreviews[id];
    if (!preview || preview.hash !== summary.hash || preview.runtimeHash !== summary.runtimeHash) {
      pkgError = "Package changed. Open the current entry source before approving it.";
      return;
    }
    aisApprovalConfirmId = "";
    if (aisApprovalTimer !== null) clearTimeout(aisApprovalTimer);
    void approveAisModule(id, capabilitiesFor(id, summary), preview.hash, preview.runtimeHash);
  }

  async function approveAisModule(id: string, capabilities: AisCapability[], reviewedHash: string | null, reviewedRuntimeHash?: string): Promise<void> {
    if (!reviewedHash) { pkgError = "Review the exact package hash before approving it."; return; }
    pkgBusy = true;
    pkgError = "";
    try {
      const result = await packages.grantAutomationCapabilities(id, capabilities, reviewedHash, reviewedRuntimeHash);
      if (!result.ok) pkgError = result.error;
      else aisPendingReload = true;
      refresh();
    } finally {
      pkgBusy = false;
    }
  }

  async function revokeAisApproval(id: string): Promise<void> {
    pkgBusy = true;
    pkgError = "";
    try {
      const result = await packages.revokeAutomationApproval(id);
      if (!result.ok) pkgError = result.error;
      else aisPendingReload = true;
      refresh();
    } finally {
      pkgBusy = false;
    }
  }

  /** D-468: sharing takes effect live (the host republishes `ais.profile`); no reload involved. */
  async function setAisSharing(id: string, shared: boolean): Promise<void> {
    pkgBusy = true;
    pkgError = "";
    try {
      const result = await packages.setAutomationSharing(id, shared);
      if (!result.ok) pkgError = result.error;
      refresh();
    } finally {
      pkgBusy = false;
    }
  }

  const reloadWorld = (): void => {
    if (typeof location !== "undefined") location.reload();
  };

  // §12 trusted in-page execution: two-step GM consent (first click arms, second click
  // within 3 s grants)
  let trustConfirmId = $state("");
  let trustTimer: ReturnType<typeof setTimeout> | null = null;
  function requestGrantTrust(id: string): void {
    if (trustConfirmId !== id) {
      trustConfirmId = id;
      if (trustTimer !== null) clearTimeout(trustTimer);
      trustTimer = setTimeout(() => (trustConfirmId = ""), 3_000);
      return;
    }
    trustConfirmId = "";
    if (trustTimer !== null) clearTimeout(trustTimer);
    void grantTrust(id);
  }
  async function grantTrust(id: string): Promise<void> {
    pkgBusy = true;
    pkgError = "";
    try {
      const res = await packages.grantTrust(id);
      if (!res.ok) pkgError = res.error;
      else aisPendingReload = true;
      refresh();
    } finally {
      pkgBusy = false;
    }
  }
  async function revokeTrust(id: string): Promise<void> {
    pkgBusy = true;
    pkgError = "";
    try {
      const res = await packages.revokeTrust(id);
      if (!res.ok) pkgError = res.error;
      else aisPendingReload = true;
      refresh();
    } finally {
      pkgBusy = false;
    }
  }
  onMount(refresh);
  onDestroy(() => { if (aisApprovalTimer !== null) clearTimeout(aisApprovalTimer); });
</script>

<div class="section" data-pkg-section>
  <h4>Packages &amp; automation (§12 · AIS v1)</h4>
  <p class="status" data-pkg-status>
    <span
      >Strategic ruleset: <b data-pkg-status-ruleset
        >{rulesBoot?.source === "package"
          ? `${active?.name ?? rulesBoot.packageId} v${rulesBoot.version} (package)`
          : `Mass Battle Basic (built-in)`}</b
      ></span
    >
    <span
      >Content: <b data-pkg-status-content
        >{contentPacks.length === 0
          ? "none"
          : `${contentPacks.map((p) => `${p.name} v${p.version}`).join(", ")} (${packTotal} pack${packTotal === 1 ? "" : "s"})`}</b
      ></span
    >
    <span data-ais-status>Automation: {automationModules.filter((module) => module.enabled).length} enabled / {automationModules.length} installed</span>
    {#if pinned}
      <span class="warn" data-pkg-pinned
        >Ruleset pinned — a turn has been resolved. To play other strategic rules, create a new
        world (New world… on the start screen).</span
      >
    {/if}
  </p>
  <p class="hint">
    The ruleset drives <b>strategic</b> scenes (heroes + units). Tactical scenes (heroes only)
    are unaffected — a world can mix both; a scene's kind is the Scale option below.
  </p>
  {#if rulesBoot?.error}
    <p class="error" data-pkg-boot-error>
      {rulesBoot.packageId ?? "The pinned ruleset"} could not load at boot — running built-in
      rules: {rulesBoot.error}
    </p>
  {/if}
  {#if rulesBoot && typeof rulesBoot.ui === "object"}
    <!-- D-475: a package UI that did not evaluate is shown, not swallowed; the rules still run. -->
    <p class="error" data-pkg-ui-error>
      {rulesBoot.packageId ?? "The pinned ruleset"} ships window components that did not load —
      its windows fall back to the shell's own views: {rulesBoot.ui.error}
    </p>
  {/if}
  {#each pkgList as p (p.id)}
    <div class="row" data-pkg-row data-pkg-id={p.id} data-pkg-type={p.type}>
      <span
        >{p.name} v{p.version} · {packageKindLabel(p.type)}{p.packCount > 0
          ? ` · ${p.packCount} pack(s)`
          : ""}</span
      >
      {#if p.missingDependencies.length > 0}
        <span
          class="warn"
          data-pkg-missing-deps
          title={`Declared companions not imported: ${p.missingDependencies.join(", ")}`}
          >needs {p.missingDependencies.join(", ")}</span
        >
      {/if}
      {#if p.type === "module"}
        {#if p.enabled}
          <span data-ais-enabled>enabled in world profile</span>
          <button type="button" data-ais-disable disabled={pkgBusy} onclick={() => disableAutomationModule(p.id)}>Disable</button>
        {:else}
          <span data-ais-disabled>disabled</span>
          <button type="button" data-ais-enable disabled={pkgBusy} onclick={() => enableAutomationModule(p.id)}>Enable</button>
        {/if}
      {:else if p.active}
        <span data-pkg-active>active</span>
      {:else if p.type === "system" && !pinned}
        <button
          type="button"
          data-pkg-activate
          disabled={pkgBusy}
          onclick={() => activatePackage(p.id)}
        >
          Activate
        </button>
      {/if}
      {#if p.trustRequested}
        {#if p.trusted}
          <span data-pkg-trusted>trusted (in-page)</span>
          <button
            type="button"
            data-trust-revoke
            disabled={pkgBusy}
            onclick={() => revokeTrust(p.id)}
          >
            Revoke trust
          </button>
        {:else}
          <span data-pkg-trust-requested>wants in-page</span>
          <button
            type="button"
            data-trust-grant
            disabled={pkgBusy}
            onclick={() => requestGrantTrust(p.id)}
          >
            {trustConfirmId === p.id ? "Confirm grant?" : "Grant in-page"}
          </button>
        {/if}
      {/if}
    </div>
    {#if p.type === "module"}
      <div class="module-review" data-ais-module-review={p.id}>
        <span title={p.hash ?? ""}>SHA-256: {p.hash ? `${p.hash.slice(0, 16)}…` : "unavailable"}</span>
        <span>{p.approved ? "Code approved on this device for this exact hash" : "Code is not approved and will not run"}</span>
        <span data-ais-runtime={aisRuntimeStatuses[p.id]?.state ?? "not-started"}
          class:error={aisRuntimeStatuses[p.id]?.state === "failed"}>
          Runtime: {aisRuntimeStatuses[p.id]?.state ?? "not started · enable, approve, then reload"}
          {#if aisRuntimeStatuses[p.id]?.error} — {aisRuntimeStatuses[p.id]?.error}{/if}
        </span>
        {#if p.runtimeProvider}<p class="hint" data-ais-runtime-provider>Runtime adapter: no standalone execution. Each guest requires separate approval; effective capabilities are the intersection of both grants.</p>{/if}
        {#if p.runtimeProviderId}<p class="hint" data-ais-runtime-binding>Experimental adapter-backed guest · {p.runtimeProviderId}. Review and enable the adapter first. Composition: {p.runtimeHash?.slice(0, 16) ?? "unresolved"}.</p>{/if}
        {#if p.runtimeError}<p class="error">{p.runtimeError}</p>{/if}
        {#if p.panel}
          <p class="hint" data-ais-panel-declared>
            Panel: “{p.panel.title}” ({p.panel.width}×{p.panel.height}) drawn inside the module's own sandbox; the shell adds the window chrome.
            {#if onOpenAisPanel}
              <button type="button" data-ais-panel-open={p.id} disabled={aisRuntimeStatuses[p.id]?.state !== "ready"}
                onclick={() => onOpenAisPanel?.(p.id)}>Open panel</button>
            {/if}
          </p>
        {/if}
        {#if p.settings.length > 0}
          <details class="ais-settings" data-ais-settings={p.id} ontoggle={(event) => { if (event.currentTarget.open) void loadAisSettings(p.id); }}>
            <summary>Settings ({p.settings.length}) · world values replicate to players, device values stay here</summary>
            {#if !aisModules}
              <p class="hint">Settings become editable once the world has booted.</p>
            {:else if aisSettingsViews[p.id]}
              <AisSettingsForm packageId={p.id} declarations={aisSettingsViews[p.id]?.declarations ?? []} values={aisSettingsViews[p.id]?.values ?? {}}
                disabled={pkgBusy} onChange={(key, value) => writeAisSetting(p.id, key, value)} />
            {:else}
              <p class="hint">Loading…</p>
            {/if}
          </details>
        {/if}
        {#if p.requires.length > 0}
          <p class="hint" data-ais-requires>Requires sibling modules: {p.requires.map((entry) => `${entry.id}${entry.version ? ` ${entry.version}` : ""}${entry.optional ? " (optional)" : ""}`).join(", ")} — enable them first; this module may invoke their commands through the module bus.</p>
        {/if}
        {#if p.provides.length > 0}
          <p class="hint" data-ais-provides>Provides: {p.provides.map((slot) => `${slot.id} (${slot.mode}, contract v${slot.contract})`).join(", ")}.</p>
        {/if}
        {#if aisModules && aisRuntimeStatuses[p.id]}
          <details class="ais-health" data-ais-health={p.id} ontoggle={(event) => { if (event.currentTarget.open) refreshAisHealth(p.id); }}>
            <summary>Health · {aisRuntimeStatuses[p.id]?.state}{#if aisRuntimeStatuses[p.id]?.error} — {aisRuntimeStatuses[p.id]?.error}{/if}</summary>
            {#if aisHealthViews[p.id]}
              {@const health = aisHealthViews[p.id]}
              <p class="hint" data-ais-health-counters>
                Requests {health?.counters.requests ?? 0} (failed {health?.counters.failures ?? 0}, rejected {health?.counters.rejected ?? 0}) ·
                commands {health?.counters.commands ?? 0} (failed {health?.counters.commandFailures ?? 0}) · events {health?.counters.events ?? 0}
                {#if health?.circuitOpenedAt} · circuit opened at {traceTime(health.circuitOpenedAt)}{/if}
              </p>
              {#if (health?.trace.length ?? 0) > 0}
                <ul class="ais-trace">
                  {#each (health?.trace ?? []).slice(-10).reverse() as entry, index (index)}
                    <li class:error={!entry.ok}>{traceTime(entry.at)} · {entry.kind} {entry.name}{#if entry.ms !== undefined} · {entry.ms} ms{/if}{#if entry.error} · {entry.error}{/if}</li>
                  {/each}
                </ul>
              {:else}
                <p class="hint">No traffic recorded yet.</p>
              {/if}
            {:else}
              <p class="hint">No health data: the module has not started on this device.</p>
            {/if}
            <button type="button" data-ais-refresh-health disabled={pkgBusy} onclick={() => refreshAisHealth(p.id)}>Refresh</button>
            <button type="button" data-ais-restart disabled={pkgBusy || p.runtimeProvider} onclick={() => void restartAisModule(p.id)}>Restart module</button>
            {#if aisHealthNotice[p.id]}<p class="hint" data-ais-health-notice>{aisHealthNotice[p.id]}</p>{/if}
          </details>
        {/if}
        {#if p.commands.length > 0}
          <p class="hint" data-ais-commands>Macro-callable commands: {p.commands.map((command) => `${command.id} (contract v${command.contract})`).join(", ")}. Calls require the separate reviewed script-macro grant.</p>
        {/if}
        {#if p.emittedEvents.length > 0}
          <p class="hint" data-ais-emitted-events>Declared custom events: {p.emittedEvents.join(", ")}. Subscribers also need the local action.observe capability.</p>
        {/if}
        <button type="button" data-ais-preview disabled={pkgBusy || aisPreviewLoadingId === p.id} onclick={() => void loadAisCodePreview(p.id)}>
          {aisPreviewLoadingId === p.id ? "Loading entry…" : aisCodePreviews[p.id] ? "Entry source shown" : "View entry source"}
        </button>
        {#if aisCodePreviews[p.id]}
          <details class="ais-source-preview" open>
            <summary>Entry file: {aisCodePreviews[p.id]?.entry}</summary>
            <pre>{aisCodePreviews[p.id]?.source}</pre>
            {#if aisCodePreviews[p.id]?.truncated}
              <p class="warn">Preview truncated at 120,000 characters. Inspect the imported ZIP for the remainder before approval.</p>
            {/if}
          </details>
        {/if}
        {#if p.requestedCapabilities.length > 0}
          <fieldset>
            <legend>Requested capabilities · local to this device</legend>
            {#each p.requestedCapabilities as capability (capability)}
              <label>
                <input
                  type="checkbox"
                  checked={capabilitiesFor(p.id, p).includes(capability)}
                  disabled={pkgBusy}
                  onchange={(event) => toggleCapability(p.id, p, capability, event.currentTarget.checked)}
                />
                {capability}
              </label>
            {/each}
          </fieldset>
        {:else}
          <p class="hint">This module requests no host capabilities; approval still allows its sandboxed code to run.</p>
        {/if}
        {#if p.approved}
          <label class="ais-share-players">
            <input type="checkbox" data-ais-share-players checked={p.sharedWithPlayers} disabled={pkgBusy || p.hostOnly}
              onchange={(event) => void setAisSharing(p.id, event.currentTarget.checked)} />
            {#if p.hostOnly}
              Host-only by the module's own declaration (<code>sharing: "host-only"</code>) — never run on player devices
            {:else}
              Players run this module too (they are asked for their own consent; their changes are limited to what they own)
            {/if}
          </label>
          <span data-ais-approved>Approved: {p.grantedCapabilities.length ? p.grantedCapabilities.join(", ") : "no capabilities"}</span>
          <button type="button" data-ais-revoke disabled={pkgBusy} onclick={() => revokeAisApproval(p.id)}>Revoke local approval</button>
          <button type="button" data-ais-update-grant disabled={pkgBusy} onclick={() => void approveAisModule(p.id, capabilitiesFor(p.id, p), p.hash, p.runtimeHash)}>Update capabilities</button>
        {:else}
          <button type="button" data-ais-approve disabled={pkgBusy || aisPreviewLoadingId === p.id} onclick={() => requestAisApproval(p.id, p)}>
            {aisApprovalConfirmId === p.id ? "Confirm sandboxed-code approval" : "Review & approve code"}
          </button>
        {/if}
      </div>
    {/if}
  {/each}
  {#if aisState}
    <div class="ais-manager" data-ais-manager>
      <h5>Contribution arbitration</h5>
      {#each aisState.resolution.providers.filter((provider) => provider.mode === "exclusive") as provider (provider.slotId)}
        <label class="provider-row">
          <span><b>{provider.slotId}</b> · exclusive contract v{provider.contract}</span>
          <select
            aria-label={`Selected provider for ${provider.slotId}`}
            value={provider.selected ?? ""}
            disabled={pkgBusy}
            onchange={(event) => void selectAutomationProvider(provider.slotId, event.currentTarget.value)}
          >
            <option value="" disabled>Select provider…</option>
            {#each provider.providers as candidate (candidate)}
              <option value={candidate}>{candidate}</option>
            {/each}
          </select>
        </label>
      {/each}
      {#each aisState.resolution.issues as issue (`${issue.kind}:${issue.packageId ?? ""}:${issue.slotId ?? ""}:${issue.message}`)}
        <p class={issue.blocking ? "error" : "warn"} data-ais-issue>{issue.message}</p>
      {/each}
    </div>
  {/if}
  {#if firstPartyMissing.length > 0}
    <div class="row" data-pkg-first-party>
      <span>Built into this release: {firstPartyMissing.map((entry) => `${entry.name} v${entry.version}`).join(", ")}</span>
      <button type="button" data-pkg-install-first-party disabled={pkgBusy} onclick={() => void installFirstParty()}>Add to this world</button>
    </div>
  {/if}
  <div class="row">
    <label for="pkg-file">Add package (.zip)</label>
    <input
      id="pkg-file"
      type="file"
      accept=".zip"
      bind:this={pkgFileInput}
      onchange={() => void importPackageZip()}
    />
  </div>
  {#if pkgError}<p class="error" data-pkg-error>{pkgError}</p>{/if}
  {#if pkgPendingReload}
    <p class="hint" data-pkg-pending>
      <b>{pkgPendingReload}</b> takes over strategic scenes when the world reloads.
      <button type="button" data-pkg-reload onclick={reloadWorld}>Reload now</button>
    </p>
  {/if}
  {#if aisPendingReload}
    <p class="hint" data-ais-pending>
      New code and grants start after reload. Disabled, replaced, or revoked modules stop immediately;
      capability changes stop the old instance until reload. Local grants are not exported with the world.
      <button type="button" data-ais-reload onclick={reloadWorld}>Reload now</button>
    </p>
  {/if}
  {#each pkgWarnings as w (w)}
    <p class="warn" data-pkg-warning>{w}</p>
  {/each}
  {#if !pinned}
    <p class="hint">
      A ruleset can be switched until the first strategic turn is resolved; content packs can be
      added at any time. Both are saved inside the world file.
    </p>
  {/if}
</div>

<style>
  .section {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  h4 {
    margin: 4px 0 0;
  }
  .status {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin: 0;
    font-size: 0.8125rem;
  }
  .row {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    align-items: center;
    font-size: 0.8125rem;
  }
  .hint {
    margin: 0;
    font-size: 0.8125rem;
    color: #7d8ea6;
  }
  .module-review,
  .ais-manager {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    padding: 8px 10px;
    border: 1px solid #34465d;
    border-radius: 6px;
    background: #101a27;
    font-size: 0.8125rem;
  }
  .module-review fieldset {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 12px;
    width: 100%;
    margin: 0;
    padding: 6px 8px;
    border: 1px solid #34465d;
    border-radius: 5px;
  }
  .module-review .ais-share-players { display: flex; gap: 8px; align-items: flex-start; font-size: 13px; }
  .module-review fieldset label {
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }
  .ais-settings, .ais-health { font-size: 13px; }
  .ais-settings summary, .ais-health summary { cursor: pointer; }
  .ais-trace { margin: 4px 0; padding-left: 18px; font-size: 12px; max-height: 160px; overflow: auto; }
  .ais-trace li.error { color: var(--danger, #c0392b); }
  .ais-source-preview {
    width: 100%;
    min-width: 0;
  }
  .ais-source-preview summary {
    cursor: pointer;
    color: #d5dfeb;
  }
  .ais-source-preview pre {
    max-height: 20rem;
    overflow: auto;
    margin: 6px 0;
    padding: 8px;
    border: 1px solid #34465d;
    border-radius: 5px;
    background: #080e16;
    white-space: pre;
    tab-size: 2;
  }
  .ais-manager h5 {
    width: 100%;
    margin: 0;
  }
  .provider-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
    width: 100%;
  }
  .provider-row select {
    max-width: 55%;
  }
  .warn {
    margin: 0;
    font-size: 0.8125rem;
    color: var(--vtt-focus, #ffd166);
  }
  .error {
    margin: 0;
    font-size: 0.8125rem;
    color: #e0736b;
  }
  label {
    font-size: 0.8125rem;
  }
</style>
