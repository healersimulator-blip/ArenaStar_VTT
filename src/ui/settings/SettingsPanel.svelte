<script lang="ts">
  /**
   * §10 settings window (GM) — active-scene grid editor (drives the canvas +
   * measurement), keybinding reference and undo/redo controls. Client-pref
   * and module sections land when their consumers do (D-079).
   */
  import { onMount } from "svelte";
  import type { ClientSync } from "../../client/sync";
  import type { ClientEvents } from "../../client/sync";
  import type { EventBus } from "../../core/events";
  import type { SceneDocument, SceneGrid, UserDocument } from "../../core/documents";
  import {
    fogSettingsOps,
    sceneDarknessOp,
    sceneFogSettings,
    type FogSettings,
  } from "../../core/fogExploration";
  import { DEFAULT_BINDINGS } from "../../core/keys";
  import {
    DEFAULT_SPEED_PER_DAY,
    MAX_SIGHT_RADIUS,
    MAX_SIGHT_WORLD_UNITS,
    catalogToJson,
    cellCensus,
    disableHexcrawlOps,
    enableHexcrawlOps,
    hexcrawlProfileOf,
    patchHexcrawlOps,
    setDaylightOps,
    setEncounterAnnounceOps,
    setEncounterModeOps,
    setPartyTokenOps,
    setSightOps,
    terrainCatalogOrDefault,
    type EncounterMode,
    type EncounterAnnounce,
    type HexcrawlProfile,
    type HexcrawlSightMode,
    type TerrainCatalog,
  } from "../../core/hexcrawl";
  import { gmState } from "../armies/gmState.svelte";
  import { viewAsOptions } from "../../core/viewAs";
  import {
    advanceClockOnRoundOf,
    playerPendingRollModeOf,
    rollHighlightFadeSecOf,
    secondsPerRoundOf,
    strategicSimultaneousOf,
    tokenHpBarsOf,
    type TokenHpBarMode,
    validateWorldSettingsPatch,
    worldSettingsFrom,
    worldSettingsOps,
  } from "../../core/worldSettings";
  import {
    ROUNDS_PER_HOUR,
    ROUNDS_PER_MINUTE,
    TICKS_PER_DAY,
    advanceWorldClockOps,
    formatWorldClock,
    pf1eClockSweepOps,
    readWorldClock,
    setWorldClockOps,
  } from "../../packages/pf1e/worldClock";
  import { autoResolveAoosOf } from "../../packages/pf1e/aooSettings";
  import type { HostPackages, HostRulesBoot } from "../../app/hostBoot";
  import RulesetSection from "../packages/RulesetSection.svelte";
  import AgentsSection from "./AgentsSection.svelte";
  import type { AgentManager } from "../../app/agentManager";
  import type { AgentAuditEntry } from "../../core/agents/bridge";

  let {
    client,
    bus,
    onUndo,
    onRedo,
    packages = null,
    rulesBoot = null,
    agents = null,
  }: {
    client: ClientSync;
    bus: EventBus<ClientEvents>;
    onUndo: () => void;
    onRedo: () => void;
    /** §12 host package surface (GM only; null hides the ruleset section). */
    packages?: HostPackages | null;
    rulesBoot?: HostRulesBoot | null;
    /**
     * §3.2 the connector's agent desk (GM only; null hides the Agents section). The window holds
     * no transport handles of its own: sessions, grants and bridges are the manager's.
     */
    agents?: AgentManager | null;
  } = $props();

  let grid = $state<SceneGrid | null>(null);
  let sceneId = $state("");

  /** World rules options (the replicated `settings` document, D-113). */
  let rulesError = $state("");
  interface RulesOptions {
    secondsPerRound: number;
    detectionMultiplier: number;
    advanceClockOnRound: boolean;
    /** P06/D-186: the app resolves movement attacks of opportunity itself. On by default. */
    autoResolveAoos: boolean;
    /** F02 — simultaneous strategic (initiative is damage order). */
    strategicSimultaneous: boolean;
    /** G-04/D-223 — Combat_Resolver_5 fidelity: units without orders march & engage. */
    strategicDoctrine: boolean;
    /** G-04/D-223 — Combat_Resolver_5 fidelity: wide fronts wrap enemy flanks. */
    strategicEnvelop: boolean;
    /** G-04/D-223 — Combat_Resolver_5 fidelity: B12 army initiative (d20 + modifier). */
    strategicArmyInitiative: boolean;
    /** F01 — roll-card area outline fade (1–10 s, default 4 s). */
    rollHighlightFadeSec: number;
    /** F03 — player reaction rolls: auto / savesChecksAuto / manual */
    playerPendingRollMode: "auto" | "savesChecksAuto" | "manual";
    /** §2.2/G-10a: who draws token hit-point bars (gm / all / hover). */
    tokenHpBars: TokenHpBarMode;
  }
  /** E05 (D-146): the replicated world clock, seconds. */
  let clockSeconds = $state(0);
  const DEFAULT_RULES: RulesOptions = {
    secondsPerRound: 6,
    detectionMultiplier: 1,
    advanceClockOnRound: true,
    autoResolveAoos: true,
    strategicSimultaneous: false,
    strategicDoctrine: false,
    strategicEnvelop: false,
    strategicArmyInitiative: false,
    rollHighlightFadeSec: 4,
    playerPendingRollMode: "savesChecksAuto",
    tokenHpBars: "gm",
  };
  // Initialize only after the defaults exist (opening the window executes this script).
  let rules = $state<RulesOptions>(DEFAULT_RULES);
  let scale = $state<"tactical" | "strategic">("tactical");
  /** D-250: the active scene's explored-fog flags. */
  let fog = $state<FogSettings>({ enabled: false, rangeSquares: null });
  /** §2.1: the active scene's ambient darkness (0 = bright, 1 = pitch dark). */
  let darkness = $state(0);
  /**
   * D-270: the active scene's hexcrawl profile (null when this is not a hexcrawl scene), the
   * census the overlay and the wizard both quote, and the world's terrain ladder.
   */
  let hex = $state<HexcrawlProfile | null>(null);
  let hexCensus = $state<{ total: number; authored: number; gridless: boolean }>({
    total: 0,
    authored: 0,
    gridless: false,
  });
  let hexTerrain = $state<TerrainCatalog | null>(null);
  let sceneTokens = $state<Array<{ id: string; name: string; party: boolean }>>([]);
  /** §2.3/G-25 (D-262): the players this GM can preview the table as. */
  let viewAsChoices = $state<{ id: string; name: string }[]>([]);
  /** §3.2 the agent rows (re-read on every op, because the grant is a document). */
  let agentRows = $state<ReturnType<AgentManager["list"]>>([]);
  let agentAudit = $state<AgentAuditEntry[]>([]);
  let agentScenes = $state<Array<{ id: string; name: string }>>([]);

  function refreshAgents(): void {
    if (!agents) return;
    agentRows = agents.list();
    agentAudit = agents.audit();
    agentScenes = (client.store.getAll("scenes") as readonly SceneDocument[]).map((scene) => ({
      id: scene._id,
      name: scene.name || scene._id,
    }));
  }

  function refresh(): void {
    refreshAgents();
    viewAsChoices = viewAsOptions(
      client.store.getAll("users") as readonly UserDocument[],
      client.user,
    );
    const scenes = client.store.getAll("scenes") as readonly SceneDocument[];
    const active = scenes.find((s) => s.active) ?? scenes[0] ?? null;
    sceneId = active?._id ?? "";
    grid = active ? { ...active.grid } : null;
    fog = sceneFogSettings(active);
    darkness = clampDarkness(active?.darkness);
    scale =
      (active?.flags as { core?: { scale?: unknown } } | undefined)?.core
        ?.scale === "strategic"
        ? "strategic"
        : "tactical";
    const settingsDocs = client.store.getAll("settings");
    const settings = worldSettingsFrom(settingsDocs);
    clockSeconds = readWorldClock(settingsDocs);
    hex = active ? hexcrawlProfileOf(active) : null;
    hexCensus = cellCensus(active);
    hexTerrain = terrainCatalogOrDefault(settings["hexTerrain"]);
    sceneTokens = (active?.tokens ?? []).map((t) => ({
      id: t._id,
      name: t.name || t._id,
      party:
        (t.flags as { core?: { party?: unknown } } | undefined)?.core?.party === true,
    }));
    rules = {
      secondsPerRound: secondsPerRoundOf(settings),
      detectionMultiplier:
        typeof settings.detectionMultiplier === "number" &&
        settings.detectionMultiplier > 0
          ? settings.detectionMultiplier
          : DEFAULT_RULES.detectionMultiplier,
      advanceClockOnRound: advanceClockOnRoundOf(settings),
      autoResolveAoos: autoResolveAoosOf(settings),
      strategicSimultaneous: strategicSimultaneousOf(settings),
      strategicDoctrine: settings.strategicDoctrine === true,
      strategicEnvelop: settings.strategicEnvelop === true,
      strategicArmyInitiative: settings.strategicArmyInitiative === true,
      rollHighlightFadeSec: rollHighlightFadeSecOf(settings),
      playerPendingRollMode: playerPendingRollModeOf(settings),
      tokenHpBars: tokenHpBarsOf(settings),
    };
  }

  /**
   * E05 (D-146): GM out-of-combat time controls. Advancing the replicated clock also sweeps
   * clock-counted effect durations (round/minute/hour/day anchored at apply) from both effect
   * homes, so out-of-combat time passing ends buffs exactly as combat rounds would; the deltas
   * follow this world's duration ladder (a "1 minute" button advances what a 1-minute duration
   * means here). Reset rewinds to 0 and sweeps nothing (a backward jump expires nothing).
   */
  function changeClock(unit: "minute" | "hour" | "day" | "reset"): void {
    const settingsDocs = client.store.getAll("settings");
    const settings = worldSettingsFrom(settingsDocs);
    const spr = secondsPerRoundOf(settings);
    if (unit === "reset") {
      const reset = setWorldClockOps(settingsDocs, 0);
      if (reset.length > 0) client.submit(reset);
      return;
    }
    // D-268: the buttons advance what the ladder says a minute/hour/day is, read from the same
    // constants `ttlToTicks` converts with — an hour button that advanced 100 rounds would end a
    // "1 hour" buff after ten minutes of game time.
    const ticks =
      unit === "minute" ? ROUNDS_PER_MINUTE : unit === "hour" ? ROUNDS_PER_HOUR : TICKS_PER_DAY;
    const delta = ticks * spr;
    const ops = advanceWorldClockOps(settingsDocs, delta);
    if (ops.length === 0) return;
    const sweep = pf1eClockSweepOps(
      client.store.getAll("actors") as never,
      client.store.getAll("combats") as never,
      readWorldClock(settingsDocs) + delta,
      spr,
    );
    client.submit([...ops, ...sweep.ops]);
  }

  /** Submit a rules-option patch, creating the world's settings document on first edit. */
  function applyRules(patch: Partial<RulesOptions>): void {
    const checked = validateWorldSettingsPatch({ ...patch });
    rulesError = checked.error ?? "";
    if (!checked.ok) return;
    const ops = worldSettingsOps(
      client.store.getAll("settings"),
      checked.clean,
    );
    if (ops.length === 0) return;
    client.submit(ops);
  }

  /** §9A: scale flag gates strategic fog + linked-scene behaviour (D-080). */
  function applyScale(next: "tactical" | "strategic"): void {
    if (!sceneId) return;
    const scenes = client.store.getAll("scenes") as readonly SceneDocument[];
    const scene = scenes.find((sc) => sc._id === sceneId);
    if (!scene) return;
    const flags = {
      ...scene.flags,
      core: {
        ...((scene.flags as { core?: object } | undefined)?.core ?? {}),
        scale: next,
      },
    };
    client.submit([
      { kind: "update", ref: { coll: "scenes", id: sceneId }, diff: { flags } },
    ]);
  }

  /**
   * D-250: explored fog is a per-scene switch (`flags.core.fog`) plus an optional sight
   * range in squares (`flags.core.fogRange`); both ride the same whole-object flags update
   * as the scale flag.
   */
  function applyFog(next: FogSettings): void {
    if (!sceneId) return;
    const scenes = client.store.getAll("scenes") as readonly SceneDocument[];
    const scene = scenes.find((sc) => sc._id === sceneId);
    if (!scene) return;
    fog = next;
    client.submit(fogSettingsOps(scene, next));
  }

  /**
   * §2.1 (G-24): the GM's darkness control. Darkness is a scene fact, not a client pref: it
   * rides the `scenes` document, so every client's fog loop re-reads it and the torchless
   * players stop seeing what no light reaches (see D-260 for the authority note).
   */
  function applyDarkness(value: number): void {
    const scenes = client.store.getAll("scenes") as readonly SceneDocument[];
    const scene = scenes.find((sc) => sc._id === sceneId);
    if (!scene) return;
    const next = clampDarkness(value);
    darkness = next;
    client.submit([sceneDarknessOp(scene, next)]);
  }

  /** The active scene document, or null (the panel edits the scene the GM is looking at). */
  function activeSceneDoc(): SceneDocument | null {
    const scenes = client.store.getAll("scenes") as readonly SceneDocument[];
    return scenes.find((sc) => sc._id === sceneId) ?? null;
  }

  /** D-270: enable hexcrawl on the active scene, installing the world's terrain catalog once. */
  function enableHexcrawl(): void {
    const scene = activeSceneDoc();
    if (!scene) return;
    const ops = enableHexcrawlOps(scene, { speedPerDay: DEFAULT_SPEED_PER_DAY });
    const settingsDocs = client.store.getAll("settings");
    if (worldSettingsFrom(settingsDocs)["hexTerrain"] === undefined) {
      ops.push(
        ...worldSettingsOps(settingsDocs, {
          hexTerrain: catalogToJson(terrainCatalogOrDefault(undefined)),
        }),
      );
    }
    client.submit(ops);
  }

  function disableHexcrawl(): void {
    const scene = activeSceneDoc();
    if (scene) client.submit(disableHexcrawlOps(scene));
  }

  /** One patch of the profile (`[]` back means the click changed nothing). */
  function patchHex(patch: Partial<HexcrawlProfile>): void {
    const scene = activeSceneDoc();
    if (!scene) return;
    client.submit(patchHexcrawlOps(scene, patch));
  }

  function applyHexSight(patch: {
    mode?: HexcrawlSightMode;
    radiusCells?: number;
    radiusWorldUnits?: number;
  }): void {
    const scene = activeSceneDoc();
    if (!scene || !hex) return;
    client.submit(setSightOps(scene, { ...hex.sight, ...patch }));
  }

  function apply(): void {
    if (!grid || !sceneId) return;
    client.submit([
      { kind: "update", ref: { coll: "scenes", id: sceneId }, diff: { grid } },
    ]);
  }

  /** One definition of "0…1, and a NaN reads as bright" for the field and the op. */
  function clampDarkness(value: unknown): number {
    if (typeof value !== "number" || !Number.isFinite(value)) return 0;
    return Math.max(0, Math.min(1, value));
  }

  onMount(() => {
    const offSnapshot = bus.on("snapshot", refresh);
    const offOps = bus.on("ops", refresh);
    refresh();
    // The audit is not a document, so it does not arrive as an op: poll it while the window is
    // open, which is the only time anyone can read it.
    const timer = agents ? setInterval(refreshAgents, 1500) : null;
    return () => {
      offSnapshot();
      offOps();
      if (timer !== null) clearInterval(timer);
    };
  });
</script>

<div class="settings">
  {#if packages}
    <RulesetSection {packages} {rulesBoot} />
  {/if}
  {#if agents}
    <AgentsSection
      rows={agentRows}
      scenes={agentScenes}
      audit={agentAudit}
      onAdd={(name, preset) => {
        agents?.add(name, preset);
        refreshAgents();
      }}
      onGrant={(id, patch) => {
        agents?.setGrant(id, patch);
        refreshAgents();
      }}
      onRevoke={(id) => {
        agents?.revoke(id);
        refreshAgents();
      }}
      onForget={(id) => {
        agents?.forget(id);
        refreshAgents();
      }}
      onConnect={(id, url, token) => {
        agents?.connect(id, url, token);
        refreshAgents();
      }}
    />
  {/if}
  <h4>Scene grid</h4>
  {#if grid}
    <div class="row">
      <label>
        Scale
        <select
          data-scene-scale
          value={scale}
          onchange={(e) => {
            scale = (e.target as HTMLSelectElement).value as
              "tactical" | "strategic";
            applyScale(scale);
          }}
        >
          <!-- D-248: values are the D-080 flag; labels say what each kind means -->
          <option value="tactical">tactical — heroes only</option>
          <option value="strategic"
            >strategic — heroes + units (uses the world's strategic ruleset)</option
          >
        </select>
      </label>
      <label>
        Type
        <select
          data-grid-type
          value={grid.type}
          onchange={(e) => {
            grid = {
              ...grid,
              type: (e.target as HTMLSelectElement).value as SceneGrid["type"],
            };
            apply();
          }}
        >
          {#each ["square", "hex", "gridless"] as t (t)}
            <option value={t}>{t}</option>
          {/each}
        </select>
      </label>
      <label>
        Hex layout
        <select
          data-grid-layout
          value={grid.hexLayout}
          disabled={grid.type !== "hex"}
          onchange={(e) => {
            grid = {
              ...grid,
              hexLayout: (e.target as HTMLSelectElement)
                .value as SceneGrid["hexLayout"],
            };
            apply();
          }}
        >
          {#each ["evenQ", "oddQ", "evenR", "oddR"] as l (l)}
            <option value={l}>{l}</option>
          {/each}
        </select>
      </label>
    </div>
    <div class="row">
      <label>
        Size
        <input
          data-grid-size
          type="number"
          min="10"
          max="400"
          value={grid.size}
          onchange={(e) => {
            grid = {
              ...grid,
              size: Number((e.target as HTMLInputElement).value),
            };
            apply();
          }}
        />
      </label>
      <label>
        Distance
        <input
          data-grid-distance
          type="number"
          min="1"
          value={grid.distance}
          onchange={(e) => {
            grid = {
              ...grid,
              distance: Number((e.target as HTMLInputElement).value),
            };
            apply();
          }}
        />
      </label>
      <label>
        Units
        <input
          data-grid-units
          type="text"
          value={grid.units}
          onchange={(e) => {
            grid = { ...grid, units: (e.target as HTMLInputElement).value };
            apply();
          }}
        />
      </label>
      <label>
        Diagonals
        <select
          data-grid-diagonals
          value={grid.diagonals}
          onchange={(e) => {
            grid = {
              ...grid,
              diagonals: (e.target as HTMLSelectElement)
                .value as SceneGrid["diagonals"],
            };
            apply();
          }}
        >
          {#each ["555", "5105", "euclidean"] as d (d)}
            <option value={d}>{d}</option>
          {/each}
        </select>
      </label>
    </div>
    <!-- D-250: explored fog — per scene, remembered per player, saved with the world -->
    <div class="row fog">
      <label class="check">
        <input
          data-scene-fog
          type="checkbox"
          checked={fog.enabled}
          onchange={(e) =>
            applyFog({ ...fog, enabled: (e.target as HTMLInputElement).checked })}
        />
        Fog of war — each player uncovers the map with the tokens they control and sees
        other tokens only while in sight; what they have seen stays uncovered and is saved
        with the world
      </label>
      <label>
        Sight range (squares, 0 = whole scene)
        <input
          data-scene-fog-range
          type="number"
          min="0"
          step="1"
          value={fog.rangeSquares ?? 0}
          onchange={(e) => {
            const n = Number((e.target as HTMLInputElement).value);
            applyFog({
              ...fog,
              rangeSquares: Number.isFinite(n) && n > 0 ? Math.round(n) : null,
            });
          }}
        />
      </label>
      <label class="check">
        <input data-gm-god-view type="checkbox" bind:checked={gmState.godView} />
        God view — the GM's fog is see-through (every token and map feature stays visible
        under it); off: preview the opaque cover players get
      </label>
      <label class="check">
        View as player
        <select data-gm-view-as bind:value={gmState.viewAsUser}>
          <option value="">— the GM's own view</option>
          {#each viewAsChoices as choice (choice.id)}
            <option value={choice.id}>{choice.name}</option>
          {/each}
        </select>
      </label>
      {#if gmState.viewAsUser !== ""}
        <p class="note" data-gm-view-as-note>
          Seeing what this player sees: their fog (read from what they have explored, never
          written), their tokens, their bars. Switch back to <em>the GM's own view</em> to run
          the table again.
        </p>
      {/if}
    </div>
    <!-- §2.1: how far sight carries is bounded by light; this is the ambient share of it -->
    <div class="row lighting">
      <label class="check">
        Ambient darkness
        <input
          data-scene-darkness
          type="range"
          min="0"
          max="1"
          step="0.05"
          value={darkness}
          aria-label="Ambient darkness"
          oninput={(e) => (darkness = clampDarkness(Number((e.target as HTMLInputElement).value)))}
          onchange={(e) => applyDarkness(Number((e.target as HTMLInputElement).value))}
        />
        <span class="readout" data-scene-darkness-value>{Math.round(darkness * 100)}%</span>
        — 0% is broad daylight; at 100% a token sees only what a light reaches: the torch it
        carries, a placed light, or its own darkvision (feet, on the token)
      </label>
    </div>
  {/if}

  <!--
    D-270: the hexcrawl block. The *switch* is the profile's existence (`flags.core.hexcrawl`), so
    one scene can be an overland map while its neighbours stay tactical boards; everything below is
    the profile's own data plus the census the overlay will paint.
  -->
  <h4>Hexcrawl</h4>
  {#if !hex}
    <p class="hint" data-hex-off>
      This scene is not a hexcrawl map. Enabling it turns the grid into cells with terrain, adds
      encounter tables and a party token whose travel spends world time.
    </p>
    <button type="button" data-hex-enable onclick={enableHexcrawl}>
      Enable hexcrawl on this scene
    </button>
  {:else}
    <div class="row" data-hex-on>
      <label>
        Party sight
        <select
          data-hex-sight-mode
          value={hex.sight.mode}
          onchange={(e) =>
            applyHexSight({
              mode: (e.target as HTMLSelectElement).value as HexcrawlSightMode,
            })}
        >
          <option value="gm">GM reveals hexes by hand</option>
          <option value="gm+party">GM + the party's own ring</option>
        </select>
      </label>
      {#if grid?.type === "gridless"}
        <label>
          Sight radius (units)
          <input
            data-hex-radius-units
            type="number"
            min="0"
            max={MAX_SIGHT_WORLD_UNITS}
            value={hex.sight.radiusWorldUnits}
            onchange={(e) =>
              applyHexSight({
                radiusWorldUnits: Number((e.target as HTMLInputElement).value),
              })}
          />
        </label>
      {:else}
        <label>
          Sight radius (hexes)
          <input
            data-hex-radius
            type="number"
            min="0"
            max={MAX_SIGHT_RADIUS}
            value={hex.sight.radiusCells}
            onchange={(e) =>
              applyHexSight({
                radiusCells: Number((e.target as HTMLInputElement).value),
              })}
          />
        </label>
      {/if}
    </div>
    <div class="row">
      <label>
        Encounters
        <select
          data-hex-encounter-mode
          value={hex.encounterMode}
          onchange={(e) => {
            const scene = activeSceneDoc();
            const mode = (e.target as HTMLSelectElement).value as EncounterMode;
            if (scene) client.submit(setEncounterModeOps(scene, mode));
          }}
        >
          <option value="auto">roll automatically</option>
          <option value="prompt">offer the roll (GM only)</option>
          <option value="manual">the GM rolls by hand</option>
        </select>
      </label>
      <label>
        Public encounter cards
        <select
          data-hex-encounter-announce
          value={hex.encounterAnnounce}
          onchange={(e) => {
            const scene = activeSceneDoc();
            const announce = (e.target as HTMLSelectElement).value as EncounterAnnounce;
            if (scene) client.submit(setEncounterAnnounceOps(scene, announce));
          }}
        >
          <option value="names">name the creatures</option>
          <option value="hidden">say how many, not what</option>
        </select>
      </label>
      <label>
        Party token
        <select
          data-hex-party
          value={hex.partyTokenId ?? ""}
          onchange={(e) => {
            const scene = activeSceneDoc();
            if (scene)
              client.submit(
                setPartyTokenOps(scene, (e.target as HTMLSelectElement).value || null),
              );
          }}
        >
          <option value="">— none —</option>
          {#each sceneTokens as token (token.id)}
            <option value={token.id}>{token.name}{token.party ? " (party)" : ""}</option>
          {/each}
        </select>
      </label>
    </div>
    <div class="row">
      <label>
        Dawn (hour)
        <input
          data-hex-dawn
          type="number"
          min="0"
          max="24"
          value={hex.daylight.dawnHour}
          onchange={(e) => {
            const scene = activeSceneDoc();
            if (scene)
              client.submit(
                setDaylightOps(scene, {
                  ...hex.daylight,
                  dawnHour: Number((e.target as HTMLInputElement).value),
                }),
              );
          }}
        />
      </label>
      <label>
        Dusk (hour)
        <input
          data-hex-dusk
          type="number"
          min="0"
          max="24"
          value={hex.daylight.duskHour}
          onchange={(e) => {
            const scene = activeSceneDoc();
            if (scene)
              client.submit(
                setDaylightOps(scene, {
                  ...hex.daylight,
                  duskHour: Number((e.target as HTMLInputElement).value),
                }),
              );
          }}
        />
      </label>
      <label>
        March (units/day)
        <input
          data-hex-speed
          type="number"
          min="1"
          max="240"
          value={hex.travel?.speedPerDay ?? DEFAULT_SPEED_PER_DAY}
          onchange={(e) =>
            patchHex({
              travel: hex.travel
                ? {
                    ...hex.travel,
                    speedPerDay: Number((e.target as HTMLInputElement).value),
                  }
                : null,
            })}
        />
      </label>
    </div>
    <p class="readout" data-hex-census>
      {#if hexCensus.gridless}
        {hexCensus.authored} zones drawn
      {:else}
        <span data-hex-cells>{hexCensus.total}</span> cells ·
        {hexCensus.authored} authored · reference scale
        <b data-hex-scale>1 cell = {grid?.distance ?? 0} {grid?.units ?? ""}</b>
      {/if}
    </p>
    {#if hexTerrain}
      <details class="terrain">
        <summary data-hex-terrain-summary
          >Terrain ladder — {hexTerrain.name} ({hexTerrain.terrains.length})</summary
        >
        <ul data-hex-terrain>
          {#each hexTerrain.terrains as t (t.id)}
            <li data-hex-terrain-row={t.id}>
              <span>{t.label ?? t.name}</span>
              <b>{t.cost}× a day</b>
              {#if t.road}<i>road — crosses as open ground</i>{/if}
            </li>
          {/each}
        </ul>
        <p class="hint">
          Costs are the share of a travelling day one cell takes at {DEFAULT_SPEED_PER_DAY}
          units/day; the catalog is world data (the terrain brush arrives with the overlay).
        </p>
      </details>
    {/if}
    <button type="button" data-hex-disable onclick={disableHexcrawl}>
      Turn hexcrawl off for this scene
    </button>
  {/if}

  <h4>Rules options</h4>
  <div class="row">
    <label>
      <input
        data-world-auto-aoo
        type="checkbox"
        checked={rules.autoResolveAoos}
        onchange={(e) => {
          rules = {
            ...rules,
            autoResolveAoos: (e.target as HTMLInputElement).checked,
          };
          applyRules({ autoResolveAoos: rules.autoResolveAoos });
        }}
      />
      Auto-resolve attacks of opportunity
    </label>
    <label>
      <input
        data-world-strategic-simultaneous
        type="checkbox"
        checked={rules.strategicSimultaneous}
        onchange={(e) => {
          rules = {
            ...rules,
            strategicSimultaneous: (e.target as HTMLInputElement).checked,
          };
          applyRules({ strategicSimultaneous: rules.strategicSimultaneous });
        }}
      />
      Strategic simultaneous (initiative = damage order)
    </label>
    <label>
      <input
        data-world-strategic-doctrine
        type="checkbox"
        checked={rules.strategicDoctrine}
        onchange={(e) => {
          rules = {
            ...rules,
            strategicDoctrine: (e.target as HTMLInputElement).checked,
          };
          applyRules({ strategicDoctrine: rules.strategicDoctrine });
        }}
      />
      Combat_Resolver_5 doctrine (units without orders march &amp; engage)
    </label>
    <label>
      <input
        data-world-strategic-envelop
        type="checkbox"
        checked={rules.strategicEnvelop}
        onchange={(e) => {
          rules = {
            ...rules,
            strategicEnvelop: (e.target as HTMLInputElement).checked,
          };
          applyRules({ strategicEnvelop: rules.strategicEnvelop });
        }}
      />
      Combat_Resolver_5 envelopment (wide fronts wrap flanks)
    </label>
    <label>
      <input
        data-world-strategic-army-initiative
        type="checkbox"
        checked={rules.strategicArmyInitiative}
        onchange={(e) => {
          rules = {
            ...rules,
            strategicArmyInitiative: (e.target as HTMLInputElement).checked,
          };
          applyRules({ strategicArmyInitiative: rules.strategicArmyInitiative });
        }}
      />
      Combat_Resolver_5 army initiative (B12: d20 + modifier)
    </label>
    <label>
      Player reaction rolls
      <select
        data-world-player-pending-roll-mode
        value={rules.playerPendingRollMode}
        onchange={(e) => {
          rules = {
            ...rules,
            playerPendingRollMode: (e.target as HTMLSelectElement).value as RulesOptions["playerPendingRollMode"],
          };
          applyRules({ playerPendingRollMode: rules.playerPendingRollMode });
        }}
      >
        <option value="auto">Auto (host rolls)</option>
        <option value="savesChecksAuto">Saves & checks auto (AoO/parry pending)</option>
        <option value="manual">Manual (all pending)</option>
      </select>
    </label>
    <label>
      Token HP bars
      <select
        data-world-token-hp-bars
        value={rules.tokenHpBars}
        onchange={(e) => {
          rules = {
            ...rules,
            tokenHpBars: (e.target as HTMLSelectElement).value as TokenHpBarMode,
          };
          applyRules({ tokenHpBars: rules.tokenHpBars });
        }}
      >
        <option value="gm">GM only (default)</option>
        <option value="all">Everyone (players see every bar)</option>
        <option value="hover">On hover (every replica)</option>
      </select>
    </label>
  </div>
  <div class="row">
    <label>
      Roll highlight fade (s)
      <input
        data-world-roll-highlight
        type="range"
        min="1"
        max="10"
        step="1"
        value={rules.rollHighlightFadeSec}
        oninput={(e) => {
          rules = {
            ...rules,
            rollHighlightFadeSec: Number((e.target as HTMLInputElement).value),
          };
        }}
        onchange={(e) => {
          rules = {
            ...rules,
            rollHighlightFadeSec: Number((e.target as HTMLInputElement).value),
          };
          applyRules({ rollHighlightFadeSec: rules.rollHighlightFadeSec });
        }}
      />
      <span data-world-roll-highlight-value>{rules.rollHighlightFadeSec}s</span>
    </label>
  </div>
  <div class="row">
    <label>
      Seconds / round
      <input
        data-world-seconds
        type="number"
        min="1"
        max="3600"
        value={rules.secondsPerRound}
        onchange={(e) => {
          rules = {
            ...rules,
            secondsPerRound: Number((e.target as HTMLInputElement).value),
          };
          applyRules({ secondsPerRound: rules.secondsPerRound });
        }}
      />
    </label>
    <label>
      Detection ×
      <input
        data-world-detection
        type="number"
        min="0"
        step="0.25"
        value={rules.detectionMultiplier}
        onchange={(e) => {
          rules = {
            ...rules,
            detectionMultiplier: Number((e.target as HTMLInputElement).value),
          };
          applyRules({ detectionMultiplier: rules.detectionMultiplier });
        }}
      />
    </label>
    <label>
      Advance clock
      <input
        data-world-clock
        type="checkbox"
        checked={rules.advanceClockOnRound}
        onchange={(e) => {
          rules = {
            ...rules,
            advanceClockOnRound: (e.target as HTMLInputElement).checked,
          };
          applyRules({ advanceClockOnRound: rules.advanceClockOnRound });
        }}
      />
    </label>
  </div>
  <p class="hint">
    Stored as a replicated <code>settings</code> document, so players see the clock
    their durations tick against.
  </p>
  {#if rulesError}<p class="error" data-world-error>{rulesError}</p>{/if}

  <h4>World clock</h4>
  <div class="row" data-world-clock-row>
    <span class="clock" data-clock-readout
      >{formatWorldClock(clockSeconds)}</span
    >
    <button
      data-clock-minute
      type="button"
      onclick={() => changeClock("minute")}>+1 min</button
    >
    <button data-clock-hour type="button" onclick={() => changeClock("hour")}
      >+1 h</button
    >
    <button data-clock-day type="button" onclick={() => changeClock("day")}
      >+1 day</button
    >
    <button data-clock-reset type="button" onclick={() => changeClock("reset")}
      >Reset</button
    >
  </div>
  <p class="hint">
    Out-of-combat time. Advancing it ends clock-counted effect durations
    (round/minute/hour/day) in the same measure the combat tracker uses; effects
    applied before the clock existed are never swept.
  </p>

  <h4>Keybindings</h4>
  <table class="keys">
    <tbody>
      {#each Object.entries(DEFAULT_BINDINGS) as [action, combo] (action)}
        <tr>
          <td>{action}</td>
          <td><kbd>{combo}</kbd></td>
        </tr>
      {/each}
    </tbody>
  </table>

  <h4>Edit</h4>
  <div class="row">
    <button data-settings-undo type="button" onclick={onUndo}>Undo</button>
    <button data-settings-redo type="button" onclick={onRedo}>Redo</button>
  </div>
</div>

<style>
  .settings {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  h4 {
    margin: 4px 0 0;
  }
  .row {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    align-items: flex-end;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 2px;
    font-size: 0.8125rem;
  }
  .fog {
    margin-top: 8px;
  }
  .fog .check {
    flex-direction: row;
    align-items: center;
    gap: 6px;
    flex-basis: 100%;
  }
  .fog .check input {
    width: auto;
  }
  .lighting .check {
    flex-direction: row;
    align-items: center;
    gap: 6px;
    flex-basis: 100%;
  }
  .lighting input[type="range"] {
    width: 12em;
  }
  .lighting .readout {
    width: 3em;
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  input,
  select {
    width: 7em;
  }
  table {
    border-collapse: collapse;
  }
  td {
    padding: 1px 4px;
    font-size: 0.875rem;
    border-bottom: 1px solid #262e3a;
  }
  .hint {
    margin: 0;
    font-size: 0.8125rem;
    color: #7d8ea6;
  }
  /* D-270: the hexcrawl block — a census line, and the world's terrain ladder folded away. */
  [data-hex-census] {
    margin: 4px 0 0;
    font-size: 0.8125rem;
    color: #a9bccd;
  }
  .terrain summary {
    cursor: pointer;
    font-size: 0.8125rem;
  }
  .terrain ul {
    margin: 4px 0;
    padding: 0;
    list-style: none;
    max-height: 12em;
    overflow: auto;
  }
  .terrain li {
    display: flex;
    gap: 6px;
    align-items: baseline;
    font-size: 0.8125rem;
    border-bottom: 1px solid #262e3a;
  }
  .terrain li span {
    flex: 1;
  }
  .terrain li i {
    color: #7d8ea6;
  }
  .error {
    margin: 0;
    font-size: 0.8125rem;
    color: #e0736b;
  }
  kbd {
    background: #1d2530;
    border: 1px solid #3a4656;
    border-radius: 3px;
    padding: 0 4px;
    font-size: 0.8125rem;
  }
</style>
