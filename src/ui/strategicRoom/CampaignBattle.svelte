<script lang="ts">
  import { SvelteMap } from "svelte/reactivity";
  import type { HostApp } from "../../app/hostBoot";
  import type { SceneDocument } from "../../core/documents";
  import {
    battleOf,
    sceneDeployment,
    sourceArmies,
    sourceStrategicTokens,
    strategicActionCardPolicy,
  } from "../../core/strategicRoom/campaignScene";
  import {
    MAX_SCENARIO_BACKGROUND_BYTES,
    type Scenario,
  } from "../../core/strategicRoom/scenario";
  import { signText } from "../../net/identity";
  import { campaignProof } from "../../core/strategicRoom/protocol";
  import { ensureIdentity } from "../../net/identityStore";
  import { planScenePack } from "../../core/scenePreload";
  import { writeScenePack } from "../../client/scenePack";
  let {
    app,
    scene,
    onClose,
  }: { app: HostApp; scene: SceneDocument; onClose: () => void } = $props();
  let key = $state(""),
    seats = $state(2),
    strength = $state(1),
    notice = $state(""),
    busy = $state(false);
  let actionCardsPlayerCharacters = $state(true),
    actionCardsUnits = $state(true),
    actionCardsModels = $state(false),
    actionCardPolicyInitialized = false;
  $effect(() => {
    if (actionCardPolicyInitialized) return;
    const initial = strategicActionCardPolicy(scene);
    actionCardsPlayerCharacters = initial.playerCharacters;
    actionCardsUnits = initial.units;
    actionCardsModels = initial.models;
    actionCardPolicyInitialized = true;
  });
  let invites = $state.raw<Record<string, string>>({}),
    showSetup = $state(true),
    preloadStatus = $state("");
  /** GM pulls this once; every commander can also receive it through a scene preload link. */
  let preloadUrl = $state<string | null>(null);
  async function preparePreload(): Promise<void> {
    preloadStatus = "Collecting shared scene media…";
    try {
      const blob = await buildPreload();
      if (!blob || !blob.size) {
        preloadStatus = "This scene has no shareable media.";
        return;
      }
      if (preloadUrl) URL.revokeObjectURL(preloadUrl);
      preloadUrl = URL.createObjectURL(blob);
      preloadStatus = `Scene preload ready (${(blob.size / 1024 / 1024).toFixed(1)} MiB). Open or share the link before the battle; it is not the battle.`;
    } catch (error) {
      preloadStatus = error instanceof Error ? error.message : String(error);
    }
  }
  const binding = $derived(battleOf(scene, app.worldId));
  const roomUrl = $derived(binding ? `/battle/${binding.id}/` : "");
  const source = $derived(sourceArmies(app.store, scene._id));
  const tokenSource = $derived(source.length ? [] : sourceStrategicTokens(scene));
  const playable =
    document.querySelector('meta[name="arenastar-campaign"][content="v1"]') !==
      null &&
    (location.protocol === "https:" ||
      (location.protocol === "http:" &&
        ["localhost", "127.0.0.1"].includes(location.hostname)));
  async function withBackground(
    scenario: Scenario,
    current: SceneDocument,
  ): Promise<Scenario> {
    const hash = current.img;
    if (!hash || !/^[0-9a-f]{64}$/.test(hash)) return scenario;
    const manifest = await app.assets.manifest();
    const entry = manifest[hash];
    if (!entry || !["image/png", "image/jpeg", "image/webp"].includes(entry.mime)) {
      notice = "Battlefield launched without its background: use PNG, JPEG or WebP.";
      return scenario;
    }
    if (entry.size > MAX_SCENARIO_BACKGROUND_BYTES) {
      notice = `Battlefield launched without its background: map exceeds ${MAX_SCENARIO_BACKGROUND_BYTES / 1024 / 1024} MiB hosted-art limit.`;
      return scenario;
    }
    const bytes = await app.assets.get(hash);
    if (!bytes || bytes.byteLength !== entry.size) return scenario;
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000)
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    return {
      ...scenario,
      background: {
        hash,
        mime: entry.mime as "image/png" | "image/jpeg" | "image/webp",
        size: bytes.byteLength,
        width: entry.width ?? current.width,
        height: entry.height ?? current.height,
        data: btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
      },
    };
  }
  async function command(finish = false) {
    if (busy || !key || !playable) return;
    busy = true;
    notice = "";
    let fresh = false,
      sent = false;
    try {
      const identity = await ensureIdentity(app.db);
      const publicKey = identity.publicKeyHex;
      const stored = app.store.get("scenes", scene._id);
      if (!stored) throw new Error("Scene no longer exists.");
      const actionCards = { playerCharacters: actionCardsPlayerCharacters, units: actionCardsUnits,
        models: actionCardsModels };
      const current = { ...stored, flags: { ...stored.flags,
        core: { ...stored.flags?.core, strategicActionCards: actionCards } } };
      let b = battleOf(stored, app.worldId);
      if (!b && (finish || !app.gm.channel.canLaunchHosted))
        throw new Error("Launch from setup, before starting local simulation.");
      const seed = b?.seed ?? crypto.getRandomValues(new Uint32Array(1))[0] ?? 1;
      let scenario = finish
        ? undefined
        : sceneDeployment(
            app.store,
            current,
            seed,
            b?.seats ?? seats,
            b?.strength ?? strength,
          );
      if (scenario) scenario = await withBackground(scenario, current);
      if (!b) {
        b = {
          id: crypto.randomUUID(),
          world: app.worldId,
          scene: current._id,
          seed,
          seats,
          strength,
          armies: sourceArmies(app.store, current._id).map((a) => a._id),
          factions: source.length ? (scenario?.factions ?? []).map((f) => f.id) : [],
        };
        const r = app.host.commitBattleScene(current._id, {
          "flags.core.campaignBattle": b,
          "flags.core.strategicActionCards": actionCards,
        });
        if (!r.ok) throw new Error(r.error);
        fresh = true;
      }
      await app.saves.saveNow(); // persist replay key + write fence before sending
      const at = Date.now(),
        signature = await signText(
          identity,
          campaignProof(
            finish ? "finish" : "launch",
            location.origin,
            b.id,
            at,
            scenario,
          ),
        );
      sent = true;
      const res = await fetch(
        "/api/campaign/" + (finish ? "finish" : "launch"),
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${key}`,
          },
          redirect: "error",
          cache: "no-store",
          body: JSON.stringify({
            id: b.id,
            publicKey,
            scenario,
            at,
            signature,
          }),
          signal: AbortSignal.timeout(20000),
        },
      );
      if (!res.ok) {
        if (fresh && [400, 403, 404, 405, 409, 413, 422].includes(res.status))
          release();
        const msg = await res.json().catch(() => null);
        if (finish && msg?.id === b.id && msg?.unprovisioned === true) {
          release();
          await app.saves.saveNow();
          onClose();
          return;
        }
        throw new Error(
          msg?.error ?? `Campaign service unavailable (${res.status}).`,
        );
      }
      const data = await res.json();
      if (data.id !== b.id)
        throw new Error("Unexpected campaign service response.");
      if (finish) {
        release({
          id: b.id,
          version: data.version,
          ...(data.version > 0
            ? { surviving: data.surviving, lost: data.lost }
            : {}),
        });
        invites = {};
        await app.saves.saveNow();
        onClose();
      } else {
        invites = data.invites;
        showSetup = false;
        notice = "Battle ready.";
      }
    } catch (e) {
      if (fresh && !sent) release();
      notice = e instanceof Error ? e.message : "Campaign service unavailable";
    } finally {
      key = "";
      busy = false;
    }
  }
  async function buildPreload(): Promise<Blob | null> {
    const current = app.store.get("scenes", scene._id);
    if (!current) throw new Error("Scene no longer exists.");
    const manifest = await app.assets.manifest();
    const { manifest: pack, hashes } = planScenePack({
      world: app.worldId,
      name: current.name,
      scenes: [{ id: current._id, name: current.name }],
      collections: app.store.world,
      manifest,
      createdAt: Date.now(),
    });
    const blobs = new SvelteMap<string, Uint8Array>();
    for (const hash of hashes) {
      const bytes = await app.assets.get(hash);
      if (bytes) blobs.set(hash, bytes);
    }
    return new Blob([new Uint8Array(writeScenePack(pack, blobs))], {
      type: "application/zip",
    });
  }

  function release(result?: {
    id: string;
    version: number;
    surviving?: number;
    lost?: number;
  }) {
    const r = app.host.commitBattleScene(scene._id, {
      "-=flags.core.campaignBattle": null,
      ...(result ? { "flags.core.lastHostedBattle": result } : {}),
    });
    if (!r.ok) throw new Error(r.error);
  }
</script>

<section class="campaign" aria-label="Multiplayer strategic battle">
  <header>
    <strong>{scene.name} · Multiplayer battle</strong><button
      onclick={onClose}
      disabled={busy}>Back to scene</button
    >
  </header>
  {#if !playable}<p>
      Large battles need the web-served VTT with a same-origin campaign service.
      Offline play is unchanged.
    </p>
  {:else}
    {#if binding}<button onclick={() => (showSetup = !showSetup)}
        >{showSetup ? "Hide setup" : "Manage battle & invites"}</button
      >{/if}
    {#if !binding && scene.flags.core?.lastHostedBattle && typeof scene.flags.core.lastHostedBattle === "object" && "version" in scene.flags.core.lastHostedBattle}
      <p>
        Previous battle ended at published version {String(
          scene.flags.core.lastHostedBattle.version,
        )}. {#if "surviving" in scene.flags.core.lastHostedBattle}{String(
            scene.flags.core.lastHostedBattle.surviving,
          )} models survived; {String(scene.flags.core.lastHostedBattle.lost)} lost
          in the final turn.
        {/if}Campaign unit stats unchanged.
      </p>
    {/if}
    {#if showSetup || !binding}<div>
        {#if !binding}
          {#if source.length}<p>
              {source.length} scene armies · one commander seat per army. Deploying:
              {source.map((a) => a.name).join(", ")}.
            </p>
          {:else if tokenSource.length}<p>
              {tokenSource.length} visible friendly/hostile scene tokens · one melee company
              per token, distributed across commander seats on the same side. Token centres are
              the hosted deployment anchors; hidden and neutral tokens are excluded.
            </p>
            <label
              >Commander seats <input
                type="number"
                min="2"
                max={tokenSource.length}
                bind:value={seats}
              /></label
            >
            <label
              >Models per token <input
                type="number"
                min="1"
                max="120"
                bind:value={strength}
              /></label
            >
          {:else}<label
              >Fresh roster · commander seats <input
                type="number"
                min="2"
                max="500"
                bind:value={seats}
              /></label
            >
            <label
              >Models per seat <input
                type="number"
                min="1"
                max="120"
                bind:value={strength}
              /></label
            >
            <p>
              Blue and Red split the seats. {seats * strength} models in {seats} line
              infantry units.
            </p>{/if}
          <p>
            Simultaneous PF1e turns on a five-foot square field. The battle uses
              standard infantry stats. A bounded PNG/JPEG/WebP scene background is
              transferred to the hosted board; private documents and scripts are not.
              500 seats is a configuration limit, not verified capacity.
          </p>
        {/if}
        {#if !binding}
          <fieldset>
            <legend>Action cards</legend>
            <p>Choose which action classes may publish cards. Rules still resolve when a card class is disabled.</p>
            <label><input type="checkbox" bind:checked={actionCardsPlayerCharacters} /> Player characters and unit leaders</label>
            <label><input type="checkbox" bind:checked={actionCardsUnits} /> Formation/unit actions</label>
            <label><input type="checkbox" bind:checked={actionCardsModels} /> Individual model actions</label>
            {#if actionCardsModels}<p class="warning">Individual model cards can produce thousands of records. The hosted history remains bounded, but leave this off for large battles.</p>{/if}
          </fieldset>
        {/if}
        <label
          >GM launch key <input
            type="password"
            autocomplete="off"
            bind:value={key}
          /></label
        >
        <button disabled={!key || busy} onclick={() => command()}
          >{binding
            ? "Recover invites / retry launch"
            : "Launch multiplayer battle"}</button
        >
        {#if binding}<button
            disabled={!key || busy}
            onclick={() => {
              if (
                confirm(
                  "End this battle? Pending orders will not be played. Save the last published version and aggregate survivor/loss counts on the campaign scene (visible to its readers); campaign unit stats are unchanged.",
                )
              )
                void command(true);
            }}>Finish battle</button
          >{/if}
      </div>{/if}
    {#if notice}<p role="status">{notice}</p>{/if}
    {#if binding}
      <details>
        <summary
          >Commander admission ({Object.keys(invites).length} unclaimed invites shown)</summary
        >
        <p>
          Share {location.origin}{roomUrl} and only the assigned seat’s code. Codes
          expire after 30 minutes.
        </p>
        {#each Object.entries(invites) as [id, code] (id)}<p>
            {id}: <code>{code}</code>
          </p>{/each}
      </details>
      <details>
        <summary>Scene preload for players</summary>
        <p>
          Sends the map, token art and sounds a player is already allowed to see, so
          they can cache it before the battle. It carries no players, notes, tokens,
          flags or control, and cannot reveal anything the host does not publish. Large
          maps are sent as one source image rather than thousands of tiles.
        </p>
        <button type="button" onclick={() => void preparePreload()}
          >Prepare scene preload</button
        >
        {#if preloadUrl}<p>
            <a href={preloadUrl} download="scene-preload.zip" data-scene-preload-link
              >Download scene pack</a
            >
          </p>{/if}
        {#if preloadStatus}<p role="status">{preloadStatus}</p>{/if}
      </details>
      {#if !busy}<iframe
          title="Live strategic battlefield"
          src={roomUrl + "?resume"}
        ></iframe>{/if}
    {/if}
  {/if}
</section>

<style>
  .campaign {
    position: absolute;
    inset: 54px 0 0;
    z-index: 70;
    overflow: auto;
    background: #172230;
    color: #edf1fa;
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .campaign header {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .campaign iframe {
    flex: 1;
    min-height: 220px;
    width: 100%;
    border: 0;
  }
  .campaign details {
    max-height: 150px;
    overflow: auto;
  }
  .campaign label,
  .campaign button {
    margin-right: 0.5rem;
  }
  .campaign p {
    margin: 0.35rem 0;
  }
  .campaign input {
    max-width: 16rem;
  }
</style>
