<script lang="ts">
  /**
   * §12 "Strategic ruleset & content" — the in-world view of a world's packages (D-248/D-249).
   * Lives in the Settings window: "which rules does this world run" is a settings question,
   * not an Extras one. The primary way to choose a ruleset is the New-world wizard; this
   * section is for the status line, adding content packs mid-campaign (they never touch the
   * sim), the fresh-campaign ruleset switch (activate → reload), and the D-089 trust consent.
   *
   * Scope, said on screen too: the ruleset drives strategic-scale scenes (heroes + units);
   * tactical scenes (heroes only) are unaffected, so one world mixes both.
   */
  import { onMount } from "svelte";
  import type { HostPackages, HostRulesBoot, PackageSummary } from "../../app/hostBoot";
  import { classifyZip, packageKindLabel } from "../../host/zipKind";

  let {
    packages,
    rulesBoot = null,
  }: {
    packages: HostPackages;
    rulesBoot?: HostRulesBoot | null;
  } = $props();

  let pkgList = $state<PackageSummary[]>([]);
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
  const packTotal = $derived(contentPacks.reduce((n, p) => n + p.packCount, 0));

  const refresh = (): void => {
    void packages
      .list()
      .then((list) => {
        pkgList = list;
      })
      .catch(() => {});
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
      refresh();
    } finally {
      // let the same file be picked again after a fix
      if (pkgFileInput) pkgFileInput.value = "";
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
      refresh();
    } finally {
      pkgBusy = false;
    }
  }
  onMount(refresh);
</script>

<div class="section" data-pkg-section>
  <h4>Strategic ruleset &amp; content (§12)</h4>
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
      {#if p.active}
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
  {/each}
  <div class="row">
    <label for="pkg-file"
      >{pinned ? "Add content pack (.zip)" : "Add ruleset / content pack (.zip)"}</label
    >
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
