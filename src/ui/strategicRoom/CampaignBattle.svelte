<script lang="ts">
  import { sha256 } from "@noble/hashes/sha2.js";
  import { bytesToHex } from "@noble/hashes/utils.js";
  import { SvelteMap, SvelteSet } from "svelte/reactivity";
  import { makeToken, type HostApp } from "../../app/hostBoot";
  import type { SceneDocument, TokenDocument } from "../../core/documents";
  import { fitImageToScene, sniffMedia } from "../../core/imageSizing";
  import {
    defaultStitchColumns,
    isStitchedMapTile,
    mergeStitchedSceneTiles,
    planStitchedMapTiles,
    visibleFloorMapTiles,
    type StitchPanelInput,
  } from "../../core/mapStitching";
  import {
    battleOf,
    sceneDeployment,
    sourceArmies,
    sourceStrategicTokens,
    strategicActionCardPolicy,
    withScenarioBackground,
    withScenarioBackgroundTiles,
    withScenarioBadges,
  } from "../../core/strategicRoom/campaignScene";
  import {
    MAP_SPAN,
    MAX_COMMANDERS,
    MAX_MODELS,
    MAX_SCENARIO_BACKGROUND_BYTES,
    MAX_SCENARIO_BACKGROUND_TILES,
    MAX_SCENARIO_BADGES,
    MAX_SCENARIO_BADGE_BYTES,
    MAX_SCENARIO_STITCHED_BYTES,
    MAX_UNITS,
    MAX_UNITS_PER_COMMANDER,
    type Scenario,
    type ScenarioBackground,
    type ScenarioBackgroundTile,
  } from "../../core/strategicRoom/scenario";
  import { signText } from "../../net/identity";
  import {
    campaignProof,
    type BattleReconciliationPayload,
  } from "../../core/strategicRoom/protocol";
  import {
    analyzeBattleReconciliation,
    buildBattleReconciliationOps,
    type ReconciliationAnalysis,
  } from "../../core/strategicRoom/reconcile";
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

  // Force & token builder state
  let blueName = $state("Blue"),
    blueColor = $state("#4da3ff"),
    blueUnits = $state(50),
    blueBadgeHash = $state(""),
    blueBadgeLabel = $state("");
  let redName = $state("Red"),
    redColor = $state("#ff6b6b"),
    redUnits = $state(50),
    redBadgeHash = $state(""),
    redBadgeLabel = $state("");
  let deployModels = $state(50),
    rangedPercent = $state(20),
    deployGapFt = $state(20),
    deployCols = $state(0),
    deployRows = $state(0),
    stitchCols = $state(2),
    deployBusy = $state(false);
  const currentGridCols = $derived(Math.max(1, Math.round(scene.width / Math.max(1, scene.grid.size))));
  const currentGridRows = $derived(Math.max(1, Math.round(scene.height / Math.max(1, scene.grid.size))));
  const stitchedFloorTiles = $derived(visibleFloorMapTiles(scene));

  $effect(() => {
    if (actionCardPolicyInitialized) return;
    const initial = strategicActionCardPolicy(scene);
    actionCardsPlayerCharacters = initial.playerCharacters;
    actionCardsUnits = initial.units;
    actionCardsModels = initial.models;
    actionCardPolicyInitialized = true;
  });

  // Warnings raised while preparing the launch scenario; echoed into the notice
  // once the launch response is in (withBackground/withBackgroundTiles).
  let launchNotices: string[] = [];
  let invites = $state.raw<Record<string, string>>({}),
    showSetup = $state(true),
    preloadStatus = $state(""),
    reconcilePreview = $state.raw<{
      payload: BattleReconciliationPayload;
      analysis: ReconciliationAnalysis;
    } | null>(null),
    skipConflicted = $state(true);
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

  async function uploadTeamBadge(side: "blue" | "red", event: Event): Promise<void> {
    const file = (event.currentTarget as HTMLInputElement).files?.[0];
    if (!file) return;
    deployBusy = true;
    notice = "";
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const uploaded = await app.gm.client.uploadImageAsset(bytes, {
        name: file.name,
        displayName: `${side === "blue" ? blueName : redName} token`,
        folder: "tokens/strategic",
        sourceKind: "file",
        collisionBehavior: "reuse",
        convertToWebp: false,
        webpQuality: 0.9,
      });
      if (side === "blue") {
        blueBadgeHash = uploaded.hash;
        blueBadgeLabel = file.name;
      } else {
        redBadgeHash = uploaded.hash;
        redBadgeLabel = file.name;
      }
      notice = `Uploaded ${side === "blue" ? blueName : redName} unit token (${file.name}).`;
    } catch (e) {
      notice = e instanceof Error ? e.message : String(e);
    } finally {
      deployBusy = false;
    }
  }

  async function stitchCampaignMapFiles(event: Event): Promise<void> {
    const input = event.currentTarget as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    input.value = "";
    if (!files.length || deployBusy || busy) return;
    deployBusy = true;
    notice = "";
    try {
      const stored = app.store.get("scenes", scene._id);
      if (!stored) throw new Error("Scene no longer exists.");
      const panels: StitchPanelInput[] = [];
      for (const file of files) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const sniffed = sniffMedia(bytes);
        if (sniffed.kind !== "image") throw new Error("Only PNG, JPEG or WebP images can be stitched.");
        let width = 1000, height = 1000;
        const blob = new Blob([bytes.slice().buffer as ArrayBuffer], { type: sniffed.mime });
        const url = URL.createObjectURL(blob);
        try {
          if (typeof createImageBitmap === "function") {
            const bmp = await createImageBitmap(blob);
            width = bmp.width; height = bmp.height; bmp.close();
          } else {
            const img = new Image(); img.src = url; await img.decode();
            width = img.naturalWidth; height = img.naturalHeight;
          }
        } finally {
          URL.revokeObjectURL(url);
        }
        const uploaded = await app.gm.client.uploadImageAsset(bytes, {
          name: file.name || `panel-${panels.length + 1}.png`,
          displayName: file.name || `Map panel ${panels.length + 1}`,
          folder: "Scenes/Stitched",
          sourceKind: "file",
          collisionBehavior: "reuse",
          convertToWebp: false,
          webpQuality: 0.9,
        });
        panels.push({
          id: `tile-${crypto.randomUUID().slice(0, 12)}`,
          name: file.name || `Panel ${panels.length + 1}`,
          image: uploaded.hash,
          width,
          height,
        });
      }
      const cols = Math.max(1, Math.min(64, Math.round(stitchCols || defaultStitchColumns(panels.length))));
      const plan = planStitchedMapTiles(panels, {
        columns: cols,
        mode: "fitScene",
        sceneSize: { width: stored.width, height: stored.height },
        gridSize: stored.grid.size,
      });
      await app.gm.client.submitAndWait([{
        kind: "update",
        ref: { coll: "scenes", id: stored._id },
        diff: {
          width: plan.width,
          height: plan.height,
          tiles: mergeStitchedSceneTiles(stored.tiles, plan.tiles),
        },
      }]);
      notice = `Stitched ${panels.length} map images (${plan.columns}×${plan.rows}) across ${Math.round(plan.width / stored.grid.size)}×${Math.round(plan.height / stored.grid.size)} squares.`;
    } catch (e) {
      notice = e instanceof Error ? e.message : String(e);
    } finally {
      deployBusy = false;
    }
  }

  async function clearCampaignStitchedMap(): Promise<void> {
    if (deployBusy || busy) return;
    const stored = app.store.get("scenes", scene._id);
    if (!stored) return;
    await app.gm.client.submitAndWait([{
      kind: "update",
      ref: { coll: "scenes", id: stored._id },
      diff: { tiles: stored.tiles.filter((tile) => !isStitchedMapTile(tile)) },
    }]);
    notice = "Cleared stitched map panels.";
  }

  async function deployForcesToScene(): Promise<void> {
    if (deployBusy || busy) return;
    deployBusy = true;
    notice = "";
    try {
      const stored = app.store.get("scenes", scene._id);
      if (!stored) throw new Error("Scene no longer exists.");
      const nBlue = Math.max(1, Math.min(MAX_UNITS / 2, Math.round(blueUnits)));
      const nRed = Math.max(1, Math.min(MAX_UNITS / 2, Math.round(redUnits)));
      const totalUnits = nBlue + nRed;
      const maxPerUnit = Math.max(1, Math.min(120, Math.floor(MAX_MODELS / Math.max(1, totalUnits))));
      const unitStrength = Math.max(1, Math.min(maxPerUnit, Math.round(deployModels)));
      const shotPct = Math.max(0, Math.min(100, Math.round(rangedPercent)));
      const gapFt = Math.max(10, Math.min(2000, Math.round(deployGapFt)));
      const gridSize = stored.grid.size >= 10 && stored.grid.size <= 40 ? stored.grid.size : 20;

      const files = Math.min(unitStrength, 10);
      const ranks = Math.ceil(unitStrength / 10);
      const rowStepFt = Math.max(60, files * 5 + 10);
      const colStepFt = Math.max(35, ranks * 5 + 15);
      const maxPerSide = Math.max(nBlue, nRed);
      const unitsPerLine = Math.min(maxPerSide, Math.max(5, Math.min(80, Math.ceil(Math.sqrt(maxPerSide * 2.5)))));
      const linesPerSide = Math.ceil(maxPerSide / unitsPerLine);

      const requestedWidthFt = deployCols > 0 ? deployCols * 5 : (stored.width / stored.grid.size) * 5;
      const requestedHeightFt = deployRows > 0 ? deployRows * 5 : (stored.height / stored.grid.size) * 5;
      const neededHeightFt = Math.min(
        MAP_SPAN - 60,
        Math.max(1200, requestedHeightFt, (unitsPerLine + 2) * rowStepFt),
      );
      const neededWidthFt = Math.min(
        MAP_SPAN - 60,
        Math.max(1600, requestedWidthFt, gapFt + 2 * (linesPerSide + 2) * colStepFt),
      );
      const widthPx = Math.round((neededWidthFt / 5) * gridSize);
      const heightPx = Math.round((neededHeightFt / 5) * gridSize);
      const centerXFt = neededWidthFt / 2;
      const centerYFt = neededHeightFt / 2;

      // Destructive deploy: it replaces the scene's tokens and resizes/re-grids the
      // scene, so confirm before issuing the update.
      const tokCount = stored.tokens?.length ?? 0;
      const willResize = widthPx !== stored.width || heightPx !== stored.height || gridSize !== stored.grid.size;
      if (tokCount > 0 || willResize) {
        const warning = [
          tokCount > 0 ? `replace all ${tokCount} existing scene token${tokCount === 1 ? "" : "s"}` : "",
          willResize ? `resize the scene to ${neededWidthFt}×${neededHeightFt} ft (${Math.round(neededWidthFt / 5)}×${Math.round(neededHeightFt / 5)} squares)` : "",
        ]
          .filter(Boolean)
          .join(" and ");
        if (
          !window.confirm(
            `Deploying ${nBlue} ${blueName} + ${nRed} ${redName} units will ${warning}. Continue?`,
          )
        ) {
          notice = "Deployment cancelled.";
          return;
        }
      }

      const tokens: TokenDocument[] = [];
      const buildSide = (
        count: number,
        side: "friendly" | "hostile",
        teamLabel: string,
        badgeHash: string,
      ) => {
        const lines = Math.ceil(count / unitsPerLine);
        for (let i = 0; i < count; i++) {
          const lineIdx = Math.floor(i / unitsPerLine);
          const inLineCount = Math.min(unitsPerLine, count - lineIdx * unitsPerLine);
          const rowIdx = i % unitsPerLine;
          const isShot =
            shotPct >= 100 ||
            (shotPct > 0 &&
              (lines > 1
                ? lineIdx >= Math.max(1, lines - Math.max(1, Math.round((lines * shotPct) / 100)))
                : (i * 100) % 100 < shotPct));
          const anchorXFt =
            side === "friendly"
              ? centerXFt - gapFt / 2 - lineIdx * colStepFt
              : centerXFt + gapFt / 2 + (ranks - 1) * 5 + lineIdx * colStepFt;
          const anchorYFt = centerYFt + (rowIdx - (inLineCount - 1) / 2) * rowStepFt;
          // makeToken treats x/y as the token CENTER (tokenRect): anchor_ft/5*gridSize.
          const pxX = Math.round((anchorXFt / 5) * gridSize);
          const pxY = Math.round((anchorYFt / 5) * gridSize);
          const base = makeToken(`${teamLabel} ${isShot ? "Archers" : "Guard"} ${i + 1}`, pxX, pxY);
          tokens.push({
            ...base,
            width: gridSize * 2,
            height: gridSize * 2,
            rotation: side === "friendly" ? 0 : 180,
            disposition: side,
            ...(badgeHash ? { img: badgeHash } : {}),
            flags: {
              ...base.flags,
              core: {
                ...(base.flags?.core ?? {}),
                strategicWeapon: isShot ? "shot" : "melee",
                strategicStrength: unitStrength,
              },
            },
          });
        }
      };
      buildSide(nBlue, "friendly", blueName.trim() || "Blue", blueBadgeHash);
      buildSide(nRed, "hostile", redName.trim() || "Red", redBadgeHash);

      let nextBackground = stored.background ?? {};
      if (stored.img && /^[0-9a-f]{64}$/.test(stored.img)) {
        const manifest = await app.assets.manifest();
        const entry = manifest[stored.img];
        if (entry?.width && entry?.height) {
          const fitted = fitImageToScene(
            { width: entry.width, height: entry.height },
            { width: widthPx, height: heightPx },
          );
          nextBackground = {
            ...nextBackground,
            scale: Math.round(fitted.scale * 1000) / 1000,
            offset: fitted.offset,
          };
        }
      }

      const scaleTileX = stored.width > 0 ? widthPx / stored.width : 1;
      const scaleTileY = stored.height > 0 ? heightPx / stored.height : 1;
      const rescaledTiles =
        scaleTileX !== 1 || scaleTileY !== 1
          ? stored.tiles.map((t) =>
              isStitchedMapTile(t)
                ? {
                    ...t,
                    x: Math.round(t.x * scaleTileX),
                    y: Math.round(t.y * scaleTileY),
                    width: Math.max(1, Math.round(t.width * scaleTileX)),
                    height: Math.max(1, Math.round(t.height * scaleTileY)),
                  }
                : t,
            )
          : stored.tiles;

      await app.gm.client.submitAndWait([
        {
          kind: "update",
          ref: { coll: "scenes", id: stored._id },
          diff: {
            width: widthPx,
            height: heightPx,
            grid: { ...stored.grid, type: "square", size: gridSize },
            background: nextBackground,
            tiles: rescaledTiles,
            tokens,
            "flags.core.scale": "strategic",
            "flags.core.strategicTeams": {
              friendlyName: blueName.trim() || "Blue",
              friendlyColor: blueColor,
              hostileName: redName.trim() || "Red",
              hostileColor: redColor,
            },
          },
        },
      ]);
      const minSeats = Math.max(
        2,
        Math.ceil(nBlue / MAX_UNITS_PER_COMMANDER) + Math.ceil(nRed / MAX_UNITS_PER_COMMANDER),
      );
      seats = Math.max(minSeats, Math.min(MAX_COMMANDERS, totalUnits, Math.round(totalUnits / 5) || 2));
      strength = unitStrength;
      notice = `Deployed ${nBlue} ${blueName} + ${nRed} ${redName} units (${totalUnits * unitStrength} models) across ${Math.round(neededWidthFt / 5)}×${Math.round(neededHeightFt / 5)} squares (${neededWidthFt}×${neededHeightFt} ft).`;
    } catch (e) {
      notice = e instanceof Error ? e.message : String(e);
    } finally {
      deployBusy = false;
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

  function bytesToBase64Url(bytes: Uint8Array): string {
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000)
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  async function withBackground(
    scenario: Scenario,
    current: SceneDocument,
  ): Promise<Scenario> {
    const hash = current.img;
    if (!hash || !/^[0-9a-f]{64}$/.test(hash)) return scenario;
    const manifest = await app.assets.manifest();
    const entry = manifest[hash];
    if (!entry || !["image/png", "image/jpeg", "image/webp"].includes(entry.mime)) {
      launchNotices.push("Battlefield launched without its background: use PNG, JPEG or WebP.");
      return scenario;
    }
    if (entry.size > MAX_SCENARIO_BACKGROUND_BYTES) {
      launchNotices.push(
        `Battlefield launched without its background: map exceeds ${MAX_SCENARIO_BACKGROUND_BYTES / 1024 / 1024} MiB hosted-art limit.`,
      );
      return scenario;
    }
    const bytes = await app.assets.get(hash);
    if (!bytes || bytes.byteLength !== entry.size) return scenario;
    return withScenarioBackground(scenario, {
      hash,
      mime: entry.mime as "image/png" | "image/jpeg" | "image/webp",
      size: bytes.byteLength,
      width: entry.width ?? current.width,
      height: entry.height ?? current.height,
      data: bytesToBase64Url(bytes),
    });
  }

  async function compressPanelIfOversized(
    bytes: Uint8Array,
    mime: "image/png" | "image/jpeg" | "image/webp",
    width: number,
    height: number,
  ): Promise<{ hash: string; bytes: Uint8Array; mime: "image/png" | "image/jpeg" | "image/webp"; width: number; height: number } | null> {
    if (bytes.byteLength <= MAX_SCENARIO_BACKGROUND_BYTES) {
      return { hash: bytesToHex(sha256(bytes)), bytes, mime, width, height };
    }
    if (typeof document === "undefined") return null;
    const blob = new Blob([bytes.slice().buffer as ArrayBuffer], { type: mime });
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      const scale = Math.min(1, 1536 / Math.max(1, img.naturalWidth, img.naturalHeight));
      const w = Math.max(1, Math.round(img.naturalWidth * scale));
      const h = Math.max(1, Math.round(img.naturalHeight * scale));
      const cvs = document.createElement("canvas");
      cvs.width = w;
      cvs.height = h;
      const ctx = cvs.getContext("2d");
      if (!ctx) return null;
      ctx.drawImage(img, 0, 0, w, h);
      const outBlob = await new Promise<Blob | null>((resolve) => cvs.toBlob(resolve, "image/webp", 0.82));
      if (!outBlob || outBlob.size > MAX_SCENARIO_BACKGROUND_BYTES) return null;
      const outBytes = new Uint8Array(await outBlob.arrayBuffer());
      return {
        hash: bytesToHex(sha256(outBytes)),
        bytes: outBytes,
        mime: "image/webp",
        width: w,
        height: h,
      };
    } catch {
      return null;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  async function withBackgroundTiles(
    scenario: Scenario,
    current: SceneDocument,
  ): Promise<Scenario> {
    const floorTiles = visibleFloorMapTiles(current).slice(0, MAX_SCENARIO_BACKGROUND_TILES);
    if (floorTiles.length === 0) return scenario;
    const manifest = await app.assets.manifest();
    const assets: Record<string, ScenarioBackground> = {};
    const hashRemap = new SvelteMap<string, string>();
    const placed: ScenarioBackgroundTile[] = [];
    const dropped: string[] = [];
    let totalBytes = 0;
    const ftPerPx = 5 / Math.max(1, current.grid.size);
    const tileLabel = (tile: (typeof floorTiles)[number]) => tile.name?.trim() || tile._id;

    for (const tile of floorTiles) {
      const rawHash = tile.img;
      if (!/^[0-9a-f]{64}$/.test(rawHash)) {
        dropped.push(tileLabel(tile));
        continue;
      }
      let finalHash = hashRemap.get(rawHash);
      if (!finalHash) {
        const entry = manifest[rawHash];
        if (!entry || !["image/png", "image/jpeg", "image/webp"].includes(entry.mime)) {
          dropped.push(tileLabel(tile));
          continue;
        }
        const rawBytes = await app.assets.get(rawHash);
        if (!rawBytes) {
          dropped.push(tileLabel(tile));
          continue;
        }
        const prepared = await compressPanelIfOversized(
          rawBytes,
          entry.mime as "image/png" | "image/jpeg" | "image/webp",
          entry.width ?? tile.width,
          entry.height ?? tile.height,
        );
        if (!prepared || totalBytes + prepared.bytes.byteLength > MAX_SCENARIO_STITCHED_BYTES) {
          dropped.push(tileLabel(tile));
          continue;
        }
        totalBytes += prepared.bytes.byteLength;
        finalHash = prepared.hash;
        hashRemap.set(rawHash, finalHash);
        assets[finalHash] = {
          hash: finalHash,
          mime: prepared.mime,
          size: prepared.bytes.byteLength,
          width: prepared.width,
          height: prepared.height,
          data: bytesToBase64Url(prepared.bytes),
        };
      }
      placed.push({
        hash: finalHash,
        x: Math.round(tile.x * ftPerPx * 100) / 100,
        y: Math.round(tile.y * ftPerPx * 100) / 100,
        width: Math.max(0.5, Math.round(tile.width * ftPerPx * 100) / 100),
        height: Math.max(0.5, Math.round(tile.height * ftPerPx * 100) / 100),
        ...(tile.rotation ? { rotation: tile.rotation } : {}),
      });
    }
    if (dropped.length > 0) {
      const shown = dropped.slice(0, 6).join(", ");
      launchNotices.push(
        `${dropped.length} stitched map panel${dropped.length === 1 ? "" : "s"} not projected${dropped.length > 6 ? ` (${shown} and ${dropped.length - 6} more)` : ` (${shown})`} — oversized or unreadable in the hosted battle.`,
      );
    }
    return withScenarioBackgroundTiles(scenario, placed, assets);
  }

  async function withBadges(scenario: Scenario): Promise<Scenario> {
    const wanted = new SvelteSet<string>();
    for (const c of scenario.commanders) {
      for (const u of c.units) {
        if (u.badge && wanted.size < MAX_SCENARIO_BADGES) wanted.add(u.badge);
      }
    }
    if (wanted.size === 0) return scenario;
    const manifest = await app.assets.manifest();
    const badges: Record<string, ScenarioBackground> = {};
    let totalBytes = 0;
    for (const hash of wanted) {
      const entry = manifest[hash];
      if (
        !entry ||
        !["image/png", "image/jpeg", "image/webp"].includes(entry.mime) ||
        entry.size > MAX_SCENARIO_BADGE_BYTES ||
        totalBytes + entry.size > MAX_SCENARIO_BACKGROUND_BYTES
      )
        continue;
      const bytes = await app.assets.get(hash);
      if (!bytes || bytes.byteLength !== entry.size) continue;
      totalBytes += bytes.byteLength;
      badges[hash] = {
        hash,
        mime: entry.mime as "image/png" | "image/jpeg" | "image/webp",
        size: bytes.byteLength,
        width: entry.width ?? 128,
        height: entry.height ?? 128,
        data: bytesToBase64Url(bytes),
      };
    }
    return withScenarioBadges(scenario, badges);
  }

  async function command(
    finish = false,
    options?: { previewOnly?: boolean; applyReconciliation?: boolean },
  ) {
    if (busy || !key || !playable) return;
    const previewOnly = Boolean(finish && options?.previewOnly);
    const applyReconciliation = Boolean(finish && options?.applyReconciliation);
    busy = true;
    notice = "";
    let fresh = false,
      sent = false;
    try {
      const identity = await ensureIdentity(app.db);
      const publicKey = identity.publicKeyHex;
      const stored = app.store.get("scenes", scene._id);
      if (!stored) throw new Error("Scene no longer exists.");
      const actionCards = {
        playerCharacters: actionCardsPlayerCharacters,
        units: actionCardsUnits,
        models: actionCardsModels,
      };
      const current = {
        ...stored,
        flags: {
          ...stored.flags,
          core: { ...stored.flags?.core, strategicActionCards: actionCards },
        },
      };
      let b = battleOf(stored, app.worldId);
      if (!b && (finish || !app.gm.channel.canLaunchHosted))
        throw new Error("Launch from setup, before starting local simulation.");
      launchNotices = [];
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
      if (scenario) {
        scenario = await withBackground(scenario, current);
        scenario = await withBackgroundTiles(scenario, current);
        scenario = await withBadges(scenario);
      }
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
      await app.saves.saveNow();
      const proofAction = finish ? (previewOnly ? "preview" : "finish") : "launch";
      const at = Date.now(),
        signature = await signText(
          identity,
          campaignProof(
            proofAction,
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
            ...(previewOnly ? { previewOnly: true } : {}),
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
        if (finish && !previewOnly && msg?.id === b.id && msg?.unprovisioned === true) {
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
      if (previewOnly) {
        const latestScene = app.store.get("scenes", scene._id) ?? stored;
        const payload = (data.reconciliation ?? {
          id: b.id,
          version: data.version,
          surviving: data.surviving,
          lost: data.lost,
        }) as BattleReconciliationPayload;
        reconcilePreview = {
          payload,
          analysis: analyzeBattleReconciliation(app.store, latestScene._id, payload),
        };
        notice = `Reconciliation preview loaded (turn ${payload.version}). Battle remains open.`;
      } else if (finish) {
        if (applyReconciliation && data.reconciliation) {
          const latestScene = app.store.get("scenes", scene._id) ?? stored;
          const plan = buildBattleReconciliationOps(
            app.store,
            latestScene._id,
            data.reconciliation as BattleReconciliationPayload,
            { skipConflicted },
          );
          const committed = app.host.commitBattleReconciliation(
            plan.ops,
            `Reconcile battle (${latestScene.name})`,
          );
          if (!committed.ok) throw new Error(committed.error);
        } else {
          release({
            id: b.id,
            version: data.version,
            ...(data.version > 0
              ? { surviving: data.surviving, lost: data.lost }
              : {}),
          });
        }
        reconcilePreview = null;
        invites = {};
        await app.saves.saveNow();
        onClose();
      } else {
        invites = data.invites;
        showSetup = false;
        const diagCount = scenario?.projection?.unsupported?.length ?? 0;
        const readyMessage = diagCount
          ? `Battle ready (${diagCount} projection diagnostic${diagCount === 1 ? "" : "s"}).`
          : "Battle ready.";
        notice = launchNotices.length
          ? `${readyMessage} ${launchNotices.join(" ")}`
          : readyMessage;
      }
    } catch (e) {
      if (fresh && !sent) release();
      notice = e instanceof Error ? e.message : "Campaign service unavailable";
    } finally {
      if (!previewOnly) key = "";
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

<section class="campaign" class:live={!!binding && !showSetup} aria-label="Multiplayer strategic battle">
  <header class="campaign-bar">
    <div class="bar-left">
      <strong>{scene.name} · Multiplayer battle</strong>
      {#if binding}
        <button type="button" onclick={() => (showSetup = !showSetup)}>
          {showSetup ? "Hide setup" : "Manage battle & invites"}
        </button>
      {/if}
      {#if notice}<span class="status-pill" role="status">{notice}</span>{/if}
    </div>
    <div class="bar-right">
      {#if binding}
        <details class="bar-popover">
          <summary>Commander admission ({Object.keys(invites).length} unclaimed invites shown)</summary>
          <div class="popover-body">
            <p>
              Share {location.origin}{roomUrl} and only the assigned seat’s code. Codes
              expire after 30 minutes.
            </p>
            {#each Object.entries(invites) as [id, code] (id)}
              <p class="invite-line">{id}: <code>{code}</code></p>
            {/each}
          </div>
        </details>
        <details class="bar-popover">
          <summary>Scene preload for players</summary>
          <div class="popover-body">
            <p>
              Sends the map, token art and sounds a player is already allowed to see, so
              they can cache it before the battle.
            </p>
            <button type="button" onclick={() => void preparePreload()}>Prepare scene preload</button>
            {#if preloadUrl}
              <p><a href={preloadUrl} download="scene-preload.zip" data-scene-preload-link>Download scene pack</a></p>
            {/if}
            {#if preloadStatus}<p role="status">{preloadStatus}</p>{/if}
          </div>
        </details>
      {/if}
      <button type="button" onclick={onClose} disabled={busy}>Back to scene</button>
    </div>
  </header>

  {#if !playable}
    <p class="setup-card">
      Large battles need the web-served VTT with a same-origin campaign service.
      Offline play is unchanged.
    </p>
  {:else}
    {#if !binding && scene.flags.core?.lastHostedBattle && typeof scene.flags.core.lastHostedBattle === "object" && "version" in scene.flags.core.lastHostedBattle}
      <p class="setup-card">
        Previous battle ended at published version {String(
          scene.flags.core.lastHostedBattle.version,
        )}. {#if "surviving" in scene.flags.core.lastHostedBattle}{String(
            scene.flags.core.lastHostedBattle.surviving,
          )} models survived; {String(scene.flags.core.lastHostedBattle.lost)} lost
          in the final turn.
        {/if}Campaign unit stats unchanged.
      </p>
    {/if}

    {#if showSetup || !binding}
      <div class="setup-grid">
        {#if !binding}
          <div class="setup-card">
            <h3>1. Battlefield Roster &amp; Scale</h3>
            {#if source.length}
              <p>
                {source.length} scene armies · one commander seat per army. Deploying:
                {source.map((a) => a.name).join(", ")}.
              </p>
            {:else if tokenSource.length}
              <p>
                {tokenSource.length} visible friendly/hostile scene tokens · one company
                per token, distributed across commander seats on the same side. Token centres are
                the hosted deployment anchors; hidden and neutral tokens are excluded.
              </p>
              <div class="field-row">
                <label>Commander seats <input type="number" min="2" max={Math.min(MAX_COMMANDERS, tokenSource.length)} bind:value={seats} /></label>
                <label>Models per token <input type="number" min="1" max="120" bind:value={strength} /></label>
              </div>
            {:else}
              <div class="field-row">
                <label>Fresh roster · commander seats <input type="number" min="2" max="500" bind:value={seats} /></label>
                <label>Models per seat <input type="number" min="1" max="120" bind:value={strength} /></label>
              </div>
              <p class="muted">
                Blue and Red split the seats. {seats * strength} models in {seats} line infantry units.
              </p>
            {/if}
            <p class="muted">
              Simultaneous PF1e turns on a five-foot square field. Bounded PNG/JPEG/WebP map and unit token art transfer to the hosted board.
            </p>
          </div>

          {#if !source.length}
            <div class="setup-card" data-strategic-force-builder>
              <h3>2. Strategic Force &amp; Token Art Builder</h3>
              <p class="muted">
                Place opposing Blue &amp; Red battle lines onto this scene with custom unit token emblems, melee/ranged mix, and automatic battlefield sizing.
              </p>
              <div class="team-columns">
                <div class="team-box">
                  <div class="field-row">
                    <label>Team A <input type="text" maxlength="32" data-force-blue-name bind:value={blueName} /></label>
                    <label>Color <input type="color" data-force-blue-color bind:value={blueColor} /></label>
                    <label>Units <input type="number" min="1" max="2500" data-force-blue-units bind:value={blueUnits} /></label>
                  </div>
                  <label class="file-label">
                    Blue unit token image (PNG/JPEG/WebP)
                    <input type="file" accept="image/png,image/jpeg,image/webp" data-force-blue-token onchange={(e) => void uploadTeamBadge("blue", e)} />
                    {#if blueBadgeLabel}<span class="badge-ok">✓ {blueBadgeLabel}</span>{/if}
                  </label>
                </div>
                <div class="team-box">
                  <div class="field-row">
                    <label>Team B <input type="text" maxlength="32" data-force-red-name bind:value={redName} /></label>
                    <label>Color <input type="color" data-force-red-color bind:value={redColor} /></label>
                    <label>Units <input type="number" min="1" max="2500" data-force-red-units bind:value={redUnits} /></label>
                  </div>
                  <label class="file-label">
                    Red unit token image (PNG/JPEG/WebP)
                    <input type="file" accept="image/png,image/jpeg,image/webp" data-force-red-token onchange={(e) => void uploadTeamBadge("red", e)} />
                    {#if redBadgeLabel}<span class="badge-ok">✓ {redBadgeLabel}</span>{/if}
                  </label>
                </div>
              </div>
              <div class="field-row">
                <label>Models / unit <input type="number" min="1" max="120" data-force-models bind:value={deployModels} /></label>
                <label>Ranged % <input type="number" min="0" max="100" data-force-ranged bind:value={rangedPercent} /></label>
                <label>Center gap (ft) <input type="number" min="10" max="2000" data-force-gap bind:value={deployGapFt} /></label>
                <label>Map cols (sq) <input type="number" min="0" max="4980" placeholder={String(currentGridCols)} data-deploy-cols bind:value={deployCols} /></label>
                <label>Map rows (sq) <input type="number" min="0" max="4980" placeholder={String(currentGridRows)} data-deploy-rows bind:value={deployRows} /></label>
                <button type="button" class="primary" data-force-deploy disabled={deployBusy || busy} onclick={() => void deployForcesToScene()}>
                  {deployBusy ? "Deploying…" : `Deploy ${blueUnits + redUnits} units to scene`}
                </button>
              </div>
              <div class="field-row" data-campaign-stitch-builder>
                <label>Stitch cols <input type="number" min="1" max="64" data-campaign-stitch-cols bind:value={stitchCols} disabled={deployBusy || busy} /></label>
                <label class="file-label">
                  Stitch multiple map images ({stitchedFloorTiles.length} panel{stitchedFloorTiles.length === 1 ? "" : "s"} active · {currentGridCols}×{currentGridRows} sq)
                  <input type="file" accept="image/png,image/jpeg,image/webp" multiple data-campaign-stitch-files disabled={deployBusy || busy} onchange={(e) => void stitchCampaignMapFiles(e)} />
                </label>
                {#if stitchedFloorTiles.length > 0}
                  <button type="button" data-campaign-stitch-clear disabled={deployBusy || busy} onclick={() => void clearCampaignStitchedMap()}>Clear panels</button>
                {/if}
              </div>
            </div>
          {/if}

          <fieldset class="setup-card">
            <legend>Action cards</legend>
            <p class="muted">Choose which action classes may publish cards. Rules still resolve when a card class is disabled.</p>
            <div class="check-row">
              <label><input type="checkbox" bind:checked={actionCardsPlayerCharacters} /> Player characters and unit leaders</label>
              <label><input type="checkbox" bind:checked={actionCardsUnits} /> Formation/unit actions</label>
              <label><input type="checkbox" bind:checked={actionCardsModels} /> Individual model actions</label>
            </div>
            {#if actionCardsModels}<p class="warning">Individual model cards can produce thousands of records. Leave off for large battles.</p>{/if}
          </fieldset>
        {/if}

        <div class="setup-card launch-bar">
          <label>GM launch key <input type="password" autocomplete="off" bind:value={key} /></label>
          <button class="primary" disabled={!key || busy} onclick={() => command()}>
            {binding ? "Recover invites / retry launch" : "Launch multiplayer battle"}
          </button>
          {#if binding}
            <button
              type="button"
              data-reconcile-preview-btn
              disabled={!key || busy}
              onclick={() => void command(true, { previewOnly: true })}
            >Preview reconciliation</button>
            <button
              class="danger"
              disabled={!key || busy}
              onclick={() => {
                if (
                  confirm(
                    "End this battle? Pending orders will not be played. Save the last published version and aggregate survivor/loss counts on the campaign scene (visible to its readers); campaign unit stats are unchanged.",
                  )
                )
                  void command(true);
              }}
            >Finish battle</button>
          {/if}
        </div>

        {#if binding && reconcilePreview}
          <div class="setup-card" data-reconciliation-preview>
            <h3>Reconciliation Preview · Turn {reconcilePreview.payload.version}</h3>
            <p class="muted">
              Surviving: {reconcilePreview.payload.surviving ?? 0} · Casualties: {reconcilePreview.payload.lost ?? 0} · Units: {reconcilePreview.analysis.unitChanges} · Actors: {reconcilePreview.analysis.actorResourceChanges} · Scene updates: {reconcilePreview.analysis.sceneChanges}
            </p>
            {#if reconcilePreview.analysis.conflicts.length > 0}
              <div class="warning" data-reconciliation-conflicts>
                <strong>{reconcilePreview.analysis.conflicts.length} concurrent campaign conflict(s) detected:</strong>
                {#each reconcilePreview.analysis.conflicts as cf (`${cf.coll}:${cf.id}`)}
                  <div>{cf.coll}/{cf.id} ({cf.name}): {cf.reason}</div>
                {/each}
                <label style="margin-top:4px;flex-direction:row;align-items:center;gap:6px">
                  <input type="checkbox" data-reconcile-skip-conflicts bind:checked={skipConflicted} />
                  Skip conflicted campaign documents when applying
                </label>
              </div>
            {/if}
            <div style="max-height:11rem;overflow:auto;font-size:0.83rem;margin:6px 0">
              {#each reconcilePreview.payload.units ?? [] as u (u.id)}
                <div data-reconcile-unit={u.id}>
                  <strong>{u.name}</strong>: {u.initialStrength} → {u.alive} alive ({u.lost} lost){#if u.at} at ({u.at.x}, {u.at.y}){/if}{#if u.conditions?.length} · [{u.conditions.join(", ")}]{/if}
                </div>
              {/each}
              {#each Object.entries(reconcilePreview.payload.doorStates ?? {}) as [wallId, dState] (wallId)}
                <div data-reconcile-door={wallId}>
                  <strong>Door {wallId}</strong>: {dState === 1 ? "Open" : dState === 2 ? "Locked" : "Closed"}
                </div>
              {/each}
            </div>
            <div class="field-row">
              <button
                type="button"
                class="primary"
                data-reconcile-apply-btn
                disabled={!key || busy}
                onclick={() => void command(true, { applyReconciliation: true })}
              >Finish &amp; apply reconciliation</button>
              <button
                type="button"
                disabled={busy}
                onclick={() => (reconcilePreview = null)}
              >Dismiss preview</button>
            </div>
          </div>
        {/if}
      </div>
    {/if}

    {#if binding && !busy}
      <iframe title="Live strategic battlefield" src={roomUrl + "?resume"}></iframe>
    {/if}
  {/if}
</section>

<style>
  .campaign {
    position: absolute;
    inset: 54px 0 0;
    z-index: 70;
    overflow: auto;
    background: #101823;
    color: #edf1fa;
    padding: 10px 14px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .campaign.live {
    padding: 6px 8px;
    gap: 6px;
    overflow: hidden;
  }
  .campaign-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    flex-wrap: wrap;
    background: #172332;
    border: 1px solid #2b3d54;
    border-radius: 6px;
    padding: 6px 10px;
  }
  .bar-left,
  .bar-right {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .status-pill {
    font-size: 0.85rem;
    padding: 2px 8px;
    border-radius: 999px;
    background: #20344c;
    color: #b7d7ff;
  }
  .bar-popover {
    position: relative;
  }
  .bar-popover summary {
    cursor: pointer;
    padding: 4px 8px;
    border-radius: 4px;
    background: #223246;
    border: 1px solid #354c68;
    font-size: 0.85rem;
    list-style: none;
  }
  .popover-body {
    width: min(28rem, 85vw);
    max-height: 9.5rem;
    overflow: auto;
    background: #15202e;
    border: 1px solid #3b5372;
    border-radius: 6px;
    padding: 8px 10px;
    margin-top: 4px;
  }
  .invite-line {
    font-size: 0.82rem;
    margin: 3px 0;
  }
  .setup-grid {
    display: grid;
    gap: 10px;
    max-width: 68rem;
  }
  .setup-card {
    background: #172332;
    border: 1px solid #2b3d54;
    border-radius: 8px;
    padding: 12px 14px;
    margin: 0;
  }
  .setup-card h3 {
    margin: 0 0 6px;
    font-size: 0.98rem;
    color: #d8e8ff;
  }
  .muted {
    color: #9fb2c9;
    font-size: 0.88rem;
    margin: 4px 0;
  }
  .warning {
    color: #ffb4a2;
    font-size: 0.86rem;
  }
  .team-columns {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(18rem, 1fr));
    gap: 10px;
    margin: 8px 0;
  }
  .team-box {
    background: #121c29;
    border: 1px solid #27384e;
    border-radius: 6px;
    padding: 8px 10px;
    display: grid;
    gap: 6px;
  }
  .field-row,
  .check-row,
  .launch-bar {
    display: flex;
    flex-wrap: wrap;
    align-items: end;
    gap: 10px;
  }
  .campaign label {
    display: inline-flex;
    flex-direction: column;
    gap: 3px;
    font-size: 0.85rem;
  }
  .check-row label {
    flex-direction: row;
    align-items: center;
    gap: 6px;
  }
  .file-label input[type="file"] {
    font-size: 0.8rem;
    max-width: 100%;
  }
  .badge-ok {
    color: #7ee0a3;
    font-size: 0.8rem;
  }
  .campaign input:not([type="checkbox"]):not([type="file"]):not([type="color"]) {
    background: #0f1722;
    color: #edf1fa;
    border: 1px solid #354b66;
    border-radius: 4px;
    padding: 5px 7px;
    max-width: 12rem;
  }
  .campaign button {
    background: #24354a;
    color: #edf1fa;
    border: 1px solid #3a5270;
    border-radius: 5px;
    padding: 6px 11px;
    cursor: pointer;
  }
  .campaign button.primary {
    background: #2a5ea8;
    border-color: #4d86d6;
    font-weight: 600;
  }
  .campaign button.danger {
    background: #5a252a;
    border-color: #8c3d44;
  }
  .campaign button:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .campaign iframe {
    flex: 1;
    min-height: 280px;
    width: 100%;
    border: 1px solid #283a50;
    border-radius: 6px;
  }
</style>
