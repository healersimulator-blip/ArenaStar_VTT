<script lang="ts">
  import { onDestroy, onMount, untrack } from "svelte";
  import type { ClientSync } from "../../client/sync";
  import type { AssetManifest, JournalDocument, SceneDocument } from "../../core/documents";
  import type { SceneGrid } from "../../core/documents";
  import type { ImageAction, ImageHandlingPreferences, SceneExpressDefaults } from "../../core/imageHandling";
  import { IMAGE_ACTIONS, uniqueLogicalFileName, uniqueSceneName } from "../../core/imageHandling";
  import { imageHandlingPreferencesOf } from "../../core/imageHandling";
  import { MAX_IMAGE_BYTES, aspectLockedSize, assertImageByteLength, gridFromImage, normalizeImageName, normalizeLogicalFolder, sniffMedia, isVideoMime, validateDecodedDimensions, validateHttpsImageUrl, isPinterestPinPage } from "../../core/imageSizing";
  import { readVideoSize } from "../../client/videoMedia";
  import { imageString } from "./strings";
  import { planImageAction } from "../../core/imageActions";
  import { VIDEO_SOURCE_ACTIONS } from "../../core/imageHandling";
  import type { ImageSource } from "./imageSources";

  const CORS_FALLBACK = "The browser couldn't read or load this image (it may be blocked by CORS). Save the image to your computer and drop the file here.";
  type PreparedImage = { bytes: Uint8Array; mime: string; width: number; height: number; previewUrl: string };
  type DuplicateChoice = "create" | "replace" | "reuse" | "cancel";
  type PendingDuplicate = { scene: SceneDocument; sourceIndex: number; batchAll: boolean };

  let {
    sources,
    sourceOrigin = "file",
    initialAction = null,
    client,
    scene,
    scenes,
    journals,
    selectedTokenIds,
    manifest,
    preferences,
    sceneDefaults,
    restrictedPlayerMode = false,
    canUpload,
    canWriteDocuments,
    canShare,
    onActivateScene,
    onPreferencesChange,
    onWarning,
    onClose,
  }: {
    sources: ImageSource[];
    sourceOrigin?: "file" | "paste" | "url";
    initialAction?: ImageAction | null;
    client: ClientSync;
    scene: SceneDocument | null;
    scenes: readonly SceneDocument[];
    journals: readonly JournalDocument[];
    selectedTokenIds: readonly string[];
    manifest: AssetManifest;
    preferences: ImageHandlingPreferences;
    sceneDefaults: SceneExpressDefaults;
    restrictedPlayerMode?: boolean;
    canUpload: boolean;
    canWriteDocuments: boolean;
    canShare: boolean;
    onActivateScene: (sceneId: string) => void;
    onPreferencesChange: (next: ImageHandlingPreferences) => void;
    onWarning: (message: string) => void;
    onClose: () => void;
  } = $props();

  // Snapshot once on dialog mount: each new open remounts this editor and owns its drafts.
  const initialDialogState = untrack(() => {
    const action = initialAction ?? preferences.lastUsedAction ?? preferences.defaultAction;
    const background = scene?.background;
    const sceneGridSize = scene?.grid.size ?? sceneDefaults.gridSize;
    const backgroundColor = /^#[0-9a-f]{6}$/i.test(background?.color ?? "") ? background?.color ?? "#ffffff" : "#ffffff";
    return {
      preferences: imageHandlingPreferencesOf(preferences),
      action,
      folder: action === "newScene" ? sceneDefaults.destinationLogicalFolder : preferences.defaultUploadFolder,
      urlMode: preferences.urlMode,
      shareAfter: preferences.defaultShareToPlayers,
      gridSize: scene?.grid.size ?? sceneDefaults.gridSize,
      gridType: scene?.grid.type ?? sceneDefaults.gridType,
      offsetX: background?.offset?.x ?? 0,
      offsetY: background?.offset?.y ?? 0,
      backgroundScale: background?.scale ?? 1,
      padding: background?.padding ?? 0,
      backgroundColor,
      foregroundElevation: scene?.foreground?.elevation ?? 0,
      assetGridSize: sceneGridSize,
    };
  });

  let prefs = $state(initialDialogState.preferences);
  let selectedAction = $state<ImageAction>(initialDialogState.action);
  let currentIndex = $state(0);
  let prepared = $state<PreparedImage | null>(null);
  let loading = $state(false);
  let loadError = $state("");
  let importError = $state("");
  let importWarning = $state("");
  let nameDraft = $state("");
  let folderDraft = $state(initialDialogState.folder);
  let urlMode = $state<ImageHandlingPreferences["urlMode"]>(initialDialogState.urlMode);
  let shareAfter = $state(initialDialogState.shareAfter);
  let running = $state(false);
  let progress = $state("");
  let dimensionsLock = $state(true);
  let sceneWidth = $state(1);
  let sceneHeight = $state(1);
  let gridSize = $state(initialDialogState.gridSize);
  let gridType = $state<SceneGrid["type"]>(initialDialogState.gridType);
  let squareColumns = $state(22);
  let gridWarning = $state("");
  let resizeChoice = $state<"keep" | "rescale">("keep");
  let offsetX = $state(initialDialogState.offsetX);
  let offsetY = $state(initialDialogState.offsetY);
  let backgroundScale = $state(initialDialogState.backgroundScale);
  let padding = $state(initialDialogState.padding);
  let backgroundColor = $state(initialDialogState.backgroundColor);
  let foregroundElevation = $state(initialDialogState.foregroundElevation);
  let assetGridSize = $state(initialDialogState.assetGridSize);
  let alignmentOpen = $state(false);
  let logicalCollisionChoice = $state<"reuse" | "overwrite" | null>(null);
  let pendingDuplicate = $state<PendingDuplicate | null>(null);
  let fileCollision = $state(false);
  let dialogElement = $state<HTMLElement | null>(null);
  let currentObjectUrl: string | null = null;
  let loadRevision = 0;
  let continuationAll = false;
  let duplicateChoice: DuplicateChoice | null = null;

  const source = $derived(sources[currentIndex] ?? null);
  const isUrl = $derived(source?.kind === "url");
  const imageUrl = $derived(source?.kind === "url" ? source.url : "");
  const actionAllowed = $derived.by(() => {
    if (selectedAction === "preview") return true;
    if (videoBlocks(selectedAction)) return false;
    if (selectedAction === "showPlayers") return canShare && (!restrictedPlayerMode || canWriteDocuments);
    if (canWriteDocuments) {
      if (["replaceBackground", "replaceForeground", "tileNatural", "tileFit", "tileGrid", "tokenArt"].includes(selectedAction) && !scene) return false;
      if (selectedAction === "tileGrid" && gridType === "gridless") return false;
      if (selectedAction === "tokenArt" && selectedTokenIds.length === 0) return false;
      return true;
    }
    return false;
  });
  const previewScale = $derived(Math.min(1, 500 / Math.max(1, sceneWidth), 250 / Math.max(1, sceneHeight)));
  const previewWidth = $derived(sceneWidth * previewScale);
  const previewHeight = $derived(sceneHeight * previewScale);
  const previewGridSize = $derived(Math.max(1, gridSize * previewScale));

  onMount(() => {
    void loadSource(0).catch(() => undefined);
    if (!dialogElement || typeof ResizeObserver === "undefined") return;
    let first = true;
    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (!box) return;
      if (first) { first = false; return; }
      const size = {
        width: Math.round(Math.min(1600, Math.max(420, box.width))),
        height: Math.round(Math.min(1400, Math.max(420, box.height))),
      };
      if (Math.abs(size.width - prefs.dialogWindowSizes.width) > 8 || Math.abs(size.height - prefs.dialogWindowSizes.height) > 8)
        setPreferences({ dialogWindowSizes: size });
    });
    observer.observe(dialogElement);
    return () => observer.disconnect();
  });

  onDestroy(() => releaseCurrentUrl());

  function releaseCurrentUrl(): void {
    if (currentObjectUrl) URL.revokeObjectURL(currentObjectUrl);
    currentObjectUrl = null;
  }

  function setPreferences(patch: Partial<ImageHandlingPreferences>): void {
    prefs = imageHandlingPreferencesOf({ ...prefs, ...patch });
    onPreferencesChange(prefs);
  }

  function rememberSuccess(action: ImageAction, folder: string): void {
    const normalizedFolder = normalizeLogicalFolder(folder);
    const history = normalizedFolder
      ? [normalizedFolder, ...prefs.uploadFolderHistory.filter((item) => item !== normalizedFolder)].slice(0, 10)
      : prefs.uploadFolderHistory;
    const next = imageHandlingPreferencesOf({
      ...prefs,
      defaultUploadFolder: normalizedFolder || prefs.defaultUploadFolder,
      uploadFolderHistory: history,
      ...(prefs.rememberLastAction ? { lastUsedAction: action } : {}),
    });
    prefs = next;
    onPreferencesChange(next);
  }

  function resetGeometry(image?: PreparedImage): void {
    const width = image?.width ?? prepared?.width ?? 1;
    const height = image?.height ?? prepared?.height ?? 1;
    sceneWidth = width;
    sceneHeight = height;
    dimensionsLock = true;
    const newScene = selectedAction === "newScene";
    gridType = newScene ? sceneDefaults.gridType : scene?.grid.type ?? sceneDefaults.gridType;
    gridSize = newScene ? sceneDefaults.gridSize : scene?.grid.size ?? sceneDefaults.gridSize;
    squareColumns = Math.max(1, Math.round(width / Math.max(50, gridSize)));
    offsetX = newScene ? 0 : scene?.background?.offset?.x ?? 0;
    offsetY = newScene ? 0 : scene?.background?.offset?.y ?? 0;
    backgroundScale = newScene ? 1 : scene?.background?.scale ?? 1;
    padding = newScene ? 0 : scene?.background?.padding ?? 0;
    backgroundColor = !newScene && /^#[0-9a-f]{6}$/i.test(scene?.background?.color ?? "") ? scene?.background?.color ?? "#ffffff" : "#ffffff";
    foregroundElevation = scene?.foreground?.elevation ?? 0;
    assetGridSize = newScene ? sceneDefaults.gridSize : scene?.grid.size ?? sceneDefaults.gridSize;
    resizeChoice = "keep";
    gridWarning = "";
  }

  async function loadSource(index: number): Promise<PreparedImage> {
    const next = sources[index];
    if (!next) throw new Error("No image source is selected");
    currentIndex = index;
    const revision = ++loadRevision;
    releaseCurrentUrl();
    prepared = null;
    loadError = "";
    importError = "";
    importWarning = "";
    fileCollision = false;
    logicalCollisionChoice = null;
    loading = true;
    nameDraft = normalizeImageName(next.name);
    try {
      const result = await prepareSource(next);
      if (revision !== loadRevision) {
        URL.revokeObjectURL(result.previewUrl);
        throw new Error("Image selection changed");
      }
      currentObjectUrl = result.previewUrl;
      prepared = result;
      resetGeometry(result);
      return result;
    } catch (error) {
      if (revision === loadRevision) {
        loadError = error instanceof Error ? error.message : String(error);
        prepared = null;
      }
      throw error;
    } finally {
      if (revision === loadRevision) loading = false;
    }
  }

  async function prepareSource(item: ImageSource): Promise<PreparedImage> {
    let bytes: Uint8Array;
    if (item.kind === "file") {
      assertImageByteLength(item.file.size);
      bytes = new Uint8Array(await item.file.arrayBuffer());
    } else {
      const url = validateHttpsImageUrl(item.url);
      if (isPinterestPinPage(url.href)) throw new Error("This is a Pinterest page, not an image. Copy the image address instead.");
      let response: Response;
      try {
        response = await fetch(url.href, { mode: "cors", credentials: "omit", redirect: "follow", cache: "no-store" });
      } catch {
        throw new Error(CORS_FALLBACK);
      }
      if (!response.ok) throw new Error(CORS_FALLBACK);
      try {
        const resolved = new URL(response.url || url.href);
        if (resolved.protocol !== "https:") throw new Error("The image URL redirected away from HTTPS");
      } catch (error) {
        if (error instanceof Error && error.message.includes("redirected")) throw error;
        throw new Error(CORS_FALLBACK, { cause: error });
      }
      const declaredLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(declaredLength) && declaredLength > MAX_IMAGE_BYTES)
        throw new Error("Image exceeds the 64 MB source-file limit");
      if (!response.body) throw new Error(CORS_FALLBACK);
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value) continue;
          total += value.byteLength;
          if (total > MAX_IMAGE_BYTES) {
            await reader.cancel();
            throw new Error("Image exceeds the 64 MB source-file limit");
          }
          chunks.push(value);
        }
      } catch (error) {
        if (error instanceof Error && error.message.includes("64 MB")) throw error;
        throw new Error(CORS_FALLBACK, { cause: error });
      }
      bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    }
    const sniffed = sniffMedia(bytes);
    let width: number;
    let height: number;
    const blob = new Blob([bytes.slice().buffer as ArrayBuffer], { type: sniffed.mime });
    const previewUrl = URL.createObjectURL(blob);
    try {
      if (sniffed.kind === "video") {
        // Video sizes come from the container's metadata; there is no bitmap to decode.
        ({ width, height } = await readVideoSize(previewUrl));
        validateDecodedDimensions(width, height);
      } else if (typeof createImageBitmap === "function") {
        const bitmap = await createImageBitmap(blob, { imageOrientation: "from-image" });
        try {
          width = bitmap.width;
          height = bitmap.height;
          validateDecodedDimensions(width, height);
        } finally { bitmap.close(); }
      } else {
        const image = new Image();
        image.src = previewUrl;
        await image.decode();
        width = image.naturalWidth;
        height = image.naturalHeight;
        validateDecodedDimensions(width, height);
      }
      return { bytes, mime: sniffed.mime, width, height, previewUrl };
    } catch (error) {
      URL.revokeObjectURL(previewUrl);
      if (item.kind === "url") throw new Error(CORS_FALLBACK, { cause: error });
      throw error instanceof Error ? error : new Error(String(error), { cause: error });
    }
  }

  function changeWidth(value: number): void {
    if (!Number.isFinite(value) || value < 1) return;
    const next = dimensionsLock && prepared
      ? aspectLockedSize({ width: prepared.width, height: prepared.height }, "width", value)
      : { width: Math.round(value), height: sceneHeight };
    sceneWidth = next.width;
    if (dimensionsLock) sceneHeight = next.height;
  }
  function changeHeight(value: number): void {
    if (!Number.isFinite(value) || value < 1) return;
    const next = dimensionsLock && prepared
      ? aspectLockedSize({ width: prepared.width, height: prepared.height }, "height", value)
      : { width: sceneWidth, height: Math.round(value) };
    sceneHeight = next.height;
    if (dimensionsLock) sceneWidth = next.width;
  }
  function suggestGrid(): void {
    if (!prepared) return;
    try {
      const result = gridFromImage(prepared.width, prepared.height, squareColumns);
      gridSize = result.size;
      gridType = "square";
      gridWarning = result.heightAlignmentWarning
        ? "The image height is not aligned to this square size within one pixel."
        : "Grid size calculated from image width.";
    } catch (error) {
      gridWarning = error instanceof Error ? error.message : String(error);
    }
  }

  function folderSelected(value: string): void {
    folderDraft = value;
    setPreferences({ defaultUploadFolder: value });
  }

  function changeAction(action: ImageAction): void {
    selectedAction = action;
    resetGeometry();
    if (action === "newScene") folderDraft = normalizeLogicalFolder(sceneDefaults.destinationLogicalFolder);
    else folderDraft = prefs.defaultUploadFolder;
  }

  /** Video sources are scene backgrounds only (Phase 4); they have no thumbnail, tiles or token art. */
  function videoBlocks(action: ImageAction): boolean {
    return !!prepared && isVideoMime(prepared.mime) && !VIDEO_SOURCE_ACTIONS.includes(action);
  }

  function available(action: ImageAction): boolean {
    if (action === "preview") return true;
    if (videoBlocks(action)) return false;
    if (action === "showPlayers") return canShare && (!restrictedPlayerMode || canWriteDocuments);
    if (!canWriteDocuments) return false;
    if (["replaceBackground", "replaceForeground", "tileNatural", "tileFit", "tileGrid", "tokenArt"].includes(action) && !scene) return false;
    if (action === "tileGrid" && gridType === "gridless") return false;
    if (action === "tokenArt" && selectedTokenIds.length === 0) return false;
    return true;
  }

  function logicalBehavior(): "stop" | "reuse" | "overwrite" {
    if (!canWriteDocuments) return "stop";
    if (logicalCollisionChoice) return logicalCollisionChoice;
    return sceneDefaults.duplicateFileBehavior === "ask" ? "stop" : sceneDefaults.duplicateFileBehavior;
  }

  function getSceneDuplicate(action: ImageAction, name: string): SceneDocument | null {
    return action === "newScene"
      ? scenes.find((item) => item.name.toLocaleLowerCase() === name.toLocaleLowerCase()) ?? null
      : null;
  }

  async function processOne(index: number, action: ImageAction, selectedDuplicateChoice: DuplicateChoice | null): Promise<"done" | "ask"> {
    const item = sources[index];
    if (!item) throw new Error("Image source is missing");
    const current = index === currentIndex && prepared ? prepared : await loadSource(index);
    const name = (nameDraft.trim() || normalizeImageName(item.name)).slice(0, 160);
    let targetScene = scene;
    let actualAction = action;
    const duplicate = getSceneDuplicate(action, name);
    const duplicateMode = sceneDefaults.duplicateSceneBehavior;
    let resolvedName = name;
    if (duplicate) {
      const choice = duplicateMode === "ask" ? selectedDuplicateChoice : duplicateMode === "stop" ? "cancel" : duplicateMode === "reuse" ? "reuse" : "replace";
      if (duplicateMode === "ask" && !choice) {
        pendingDuplicate = { scene: duplicate, sourceIndex: index, batchAll: continuationAll };
        return "ask";
      }
      if (choice === "cancel") throw new Error(`A scene named “${name}” already exists. Choose another name or change the duplicate policy.`);
      if (choice === "reuse") {
        onActivateScene(duplicate._id);
        rememberSuccess(action, folderDraft);
        return "done";
      }
      if (choice === "create") resolvedName = uniqueSceneName(name, scenes.map((existing) => existing.name));
      if (choice === "replace") {
        targetScene = duplicate;
        actualAction = "replaceBackground";
        offsetX = duplicate.background?.offset?.x ?? 0;
        offsetY = duplicate.background?.offset?.y ?? 0;
        backgroundScale = duplicate.background?.scale ?? 1;
        padding = duplicate.background?.padding ?? 0;
        backgroundColor = /^#[0-9a-f]{6}$/i.test(duplicate.background?.color ?? "") ? duplicate.background?.color ?? "#ffffff" : "#ffffff";
        gridType = duplicate.grid.type;
        gridSize = duplicate.grid.size;
        resizeChoice = "keep";
      }
    }

    const useLink = item.kind === "url" && urlMode === "link" && action !== "showPlayers" && action !== "preview";
    const shouldShare = action === "showPlayers" || (shareAfter && canShare && (!restrictedPlayerMode || canWriteDocuments));
    const needsStoredAsset = (!useLink || shouldShare) && (action !== "preview" || shouldShare);
    let imageRef = item.kind === "url" && useLink ? item.url : "";
    let thumbnail: string | null = null;
    let storedHash: string | null = null;
    if (needsStoredAsset) {
      if (!canUpload) throw new Error("Persistent image uploads require GM permission or a GM-granted Trusted upload; ask the GM to change player mode.");
      progress = `Uploading ${index + 1} of ${sources.length}…`;
      const uploaded = await client.uploadImageAsset(current.bytes, {
        name: item.name,
        displayName: resolvedName,
        folder: normalizeLogicalFolder(folderDraft),
        sourceKind: item.kind === "url" ? "url" : sourceOrigin === "paste" ? "paste" : "file",
        collisionBehavior: logicalBehavior(),
        // Video is stored as its original container; WebP conversion applies to images only.
        convertToWebp: isVideoMime(current.mime) ? false : prefs.webpConvert,
        webpQuality: prefs.webpQuality,
      });
      storedHash = uploaded.hash;
      imageRef = uploaded.hash;
      thumbnail = uploaded.thumbnail ?? null;
      if (uploaded.auditWarning) {
        importWarning = uploaded.auditWarning;
        onWarning(uploaded.auditWarning);
      }
    }
    if (!imageRef) imageRef = item.kind === "url" ? item.url : storedHash ?? "";

    if (action !== "preview" && actualAction !== "showPlayers") {
      if (videoBlocks(actualAction)) throw new Error(imageString("videoOnlyBackground"));
      const plan = planImageAction({
        action: actualAction,
        image: imageRef,
        name: resolvedName,
        width: current.width,
        height: current.height,
        scene: targetScene,
        scenes,
        journals,
        selectedTokenIds,
        sceneDefaults: {
          ...sceneDefaults,
          navigation: sceneDefaults.navigation || prefs.defaultNavigation,
          activateImmediately: sceneDefaults.activateImmediately || prefs.activateNewScene,
        },
        newSceneId: `scene-${crypto.randomUUID().slice(0, 12)}`,
        newTileId: `tile-${crypto.randomUUID().slice(0, 12)}`,
        newJournalId: `journal-${crypto.randomUUID().slice(0, 12)}`,
        newPageId: `page-${crypto.randomUUID().slice(0, 12)}`,
        targetJournalId: prefs.targetJournal,
        autoCreateJournal: prefs.autoCreateJournal,
        autoCreateJournalName: prefs.autoCreateJournalName,
        logicalFolder: normalizeLogicalFolder(folderDraft),
        thumbnail,
        background: {
          offset: { x: offsetX, y: offsetY },
          scale: backgroundScale,
          padding,
          color: backgroundColor,
        },
        sceneSize: { width: sceneWidth, height: sceneHeight },
        resizeChoice,
        grid: {
          type: gridType,
          size: gridType === "gridless" ? 100 : gridSize,
          distance: targetScene?.grid.distance ?? 5,
          units: targetScene?.grid.units ?? "ft",
          diagonals: targetScene?.grid.diagonals ?? "555",
          hexLayout: targetScene?.grid.hexLayout ?? "evenQ",
        },
        assetGridSize,
        foregroundElevation,
        activateNewScene: prefs.activateNewScene,
      });
      if (plan.ops.length) {
        progress = "Saving the image action…";
        try {
          await client.submitAndWait(plan.ops);
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          const folder = normalizeLogicalFolder(folderDraft) || "root";
          throw new Error(`The image upload succeeded, but its destination action was rejected. The asset remains in logical folder “${folder}”. ${detail}`, { cause: error });
        }
      }
      if (plan.focusSceneId && (prefs.activateNewScene || sceneDefaults.activateImmediately)) onActivateScene(plan.focusSceneId);
    }

    if (shouldShare) {
      const shareHash = storedHash ?? (useLink ? null : /^[a-f0-9]{64}$/i.test(imageRef) ? imageRef : null);
      if (!shareHash) throw new Error("Show to players requires a stored copy. Switch URL mode to Store or enable image sharing.");
      progress = `Sharing ${index + 1} of ${sources.length}…`;
      await client.shareImageToPlayers(shareHash);
    }
    rememberSuccess(action, folderDraft);
    return "done";
  }

  function validateForm(action: ImageAction): void {
    if (!nameDraft.trim()) throw new Error("Enter a name for this image.");
    if (folderDraft.length > 240) throw new Error("Logical folders are limited to 240 characters.");
    if (action === "newScene" || action === "replaceBackground") {
      if (![sceneWidth, sceneHeight].every((value) => Number.isSafeInteger(value) && value > 0 && value <= 100000))
        throw new Error("Scene width and height must be whole pixels from 1 to 100,000.");
      if (gridType !== "gridless" && (!Number.isSafeInteger(gridSize) || gridSize < 50 || gridSize > 1000))
        throw new Error("Grid size must be an integer from 50 to 1,000 pixels.");
      if (!Number.isFinite(backgroundScale) || backgroundScale < 0.1 || backgroundScale > 10)
        throw new Error("Background scale must be between 0.1 and 10.");
      if (!Number.isFinite(padding) || padding < 0 || padding > 1)
        throw new Error("Background padding must be from 0 to 100 percent.");
    }
    if (action === "tileGrid" && (!Number.isSafeInteger(assetGridSize) || assetGridSize < 50))
      throw new Error("Asset Grid Size must be an integer of at least 50 pixels.");
    if (action === "replaceForeground" && !Number.isFinite(foregroundElevation))
      throw new Error("Foreground elevation must be a number.");
  }

  async function processBatch(all: boolean, choiceForCurrent: DuplicateChoice | null = null): Promise<void> {
    if (running || !available(selectedAction)) return;
    try { validateForm(selectedAction); }
    catch (error) { importError = error instanceof Error ? error.message : String(error); return; }
    if (selectedAction === "preview" && !shareAfter) {
      rememberSuccess(selectedAction, folderDraft);
      onClose();
      return;
    }
    running = true;
    importError = "";
    fileCollision = false;
    progress = "";
    continuationAll = all;
    const action = selectedAction;
    const end = all ? sources.length : Math.min(sources.length, currentIndex + 1);
    try {
      for (let i = currentIndex; i < end; i++) {
        const result = await processOne(i, action, i === currentIndex ? choiceForCurrent ?? duplicateChoice : null);
        duplicateChoice = null;
        if (result === "ask") {
          running = false;
          return;
        }
        progress = `Completed ${i + 1} of ${sources.length}`;
      }
      if (all || currentIndex + 1 >= sources.length) {
        progress = "Import complete";
        onClose();
      } else {
        progress = "";
        await loadSource(currentIndex + 1);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      importError = message;
      fileCollision = /^A file named .+ already exists in /i.test(message);
    } finally {
      running = false;
    }
  }

  function resolveDuplicate(choice: DuplicateChoice): void {
    const pending = pendingDuplicate;
    if (!pending) return;
    pendingDuplicate = null;
    duplicateChoice = choice;
    currentIndex = pending.sourceIndex;
    void processBatch(pending.batchAll, choice);
  }

  function resolveFileCollision(choice: "create" | "reuse" | "overwrite" | "cancel"): void {
    fileCollision = false;
    if (choice === "cancel") {
      logicalCollisionChoice = null;
      importError = "No asset or document was written for this image.";
      if (continuationAll && currentIndex + 1 < sources.length) {
        const nextIndex = currentIndex + 1;
        void loadSource(nextIndex).then(() => processBatch(true)).catch(() => undefined);
      }
      return;
    }
    logicalCollisionChoice = choice === "create" ? "stop" : choice;
    if (choice === "create")
      nameDraft = uniqueLogicalFileName(nameDraft, normalizeLogicalFolder(folderDraft), manifest);
    void processBatch(continuationAll);
  }

  function cancel(): void {
    if (running) return;
    onClose();
  }

  function keydown(event: KeyboardEvent): void {
    if (event.key === "Escape" && !running) { event.stopPropagation(); cancel(); }
  }

  function actionLabel(action: ImageAction): string {
    return ({
      newScene: "New scene",
      replaceBackground: "Replace scene background",
      replaceForeground: "Replace scene foreground",
      tileNatural: "Centered tile at natural size",
      tileFit: "Centered tile fitted to scene",
      tileGrid: "Tile at Asset Grid Size",
      journalPage: "Create journal image page",
      tokenArt: "Apply to selected token(s)",
      showPlayers: "Show to players",
      preview: "Preview only",
    } as Record<ImageAction, string>)[action];
  }
</script>

<svelte:window onkeydown={keydown} />
<div class="backdrop" role="presentation" onclick={(event) => { if (event.target === event.currentTarget) cancel(); }}>
  <div
    bind:this={dialogElement}
    class="dialog"
    role="dialog"
    aria-modal="true"
    aria-labelledby="image-dialog-title"
    style={`width:${prefs.dialogWindowSizes.width}px;height:${prefs.dialogWindowSizes.height}px`}
    data-image-import-dialog
  >
    <header class="dialog-head">
      <div><p class="eyebrow">IMAGE WORKFLOW · {currentIndex + 1}/{sources.length}</p><h2 id="image-dialog-title">Preview and choose a destination</h2></div>
      <button type="button" class="close" aria-label="Close image preview" disabled={running} onclick={cancel}>×</button>
    </header>

    <div class="dialog-body">
      <aside class="preview-column">
        <div class="preview-frame">
          {#if prepared}
            {#if isVideoMime(prepared.mime)}
              <video src={prepared.previewUrl} muted loop autoplay playsinline aria-label={imageString("videoPreviewLabel")}></video>
            {:else}
              <img src={prepared.previewUrl} alt={`Preview of ${source?.name ?? "image"}`} />
            {/if}
          {:else if loading}<span>Loading image…</span>
          {:else}<span>Preview unavailable</span>{/if}
        </div>
        {#if prepared}
          <p class="metadata">{prepared.width.toLocaleString()} × {prepared.height.toLocaleString()} px · {prepared.mime} · {(prepared.bytes.byteLength / 1024 / 1024).toFixed(2)} MB</p>
          {#if Math.max(prepared.width, prepared.height) > 4096}<p class="notice">Large map: the host will create 1024 px WebP tiles for rendering.</p>{/if}
        {/if}
        {#if sources.length > 1}
          <nav class="source-list" aria-label="Images in this batch">
            {#each sources as item, i (i)}
              <button type="button" class:current={currentIndex === i} disabled={running} onclick={() => void loadSource(i)} title={item.name}>{i + 1}. {item.name}</button>
            {/each}
          </nav>
        {/if}
      </aside>

      <div class="form-column">
        {#if loadError}<div class="error" role="alert"><span>{loadError}</span><button type="button" disabled={loading || running} onclick={() => void loadSource(currentIndex).catch(() => undefined)}>Retry</button></div>{/if}
        {#if importError}<p class="error" role="alert">{importError}</p>{/if}
        {#if importWarning}<p class="warning" role="status">{importWarning}</p>{/if}
        {#if fileCollision}
          <div class="collision" role="group" aria-label="Resolve folder collision">
            <strong>Choose what to do with this logical file name:</strong>
            <button type="button" disabled={running || !canWriteDocuments} onclick={() => resolveFileCollision("create")}>Create a new name</button>
            <button type="button" disabled={running || !canWriteDocuments} onclick={() => resolveFileCollision("reuse")}>Reuse existing file</button>
            <button type="button" disabled={running || !canWriteDocuments} onclick={() => resolveFileCollision("overwrite")}>Replace folder entry</button>
            <button type="button" disabled={running} onclick={() => resolveFileCollision("cancel")}>Cancel this image</button>
          </div>
        {/if}
        {#if pendingDuplicate}
          <div class="collision" role="group" aria-label="Resolve scene name collision">
            <strong>A scene named “{pendingDuplicate.scene.name}” already exists.</strong>
            <button type="button" onclick={() => resolveDuplicate("create")}>Create another scene</button>
            <button type="button" onclick={() => resolveDuplicate("replace")}>Replace its background</button>
            <button type="button" onclick={() => resolveDuplicate("reuse")}>Reuse existing scene</button>
            <button type="button" onclick={() => resolveDuplicate("cancel")}>Cancel this image</button>
          </div>
        {/if}
        {#if source}
          <label>Document name
            <input bind:value={nameDraft} maxlength="160" disabled={running} />
          </label>
          {#if isUrl}
            <div class="url-source"><strong>URL source ({urlMode === "store" ? "Store" : "Link"})</strong><code>{imageUrl}</code>
              <label>Use source
                <select bind:value={urlMode} disabled={running} onchange={() => setPreferences({ urlMode })}>
                  <option value="store">Store a copy (default)</option><option value="link">Link to this HTTPS URL</option>
                </select>
              </label>
              {#if urlMode === "link"}<p class="warning">This full URL will be saved in the world document and requested by each viewer. It may contain private query tokens.</p>{/if}
            </div>
          {/if}

          <label>Destination action
            <select value={selectedAction} disabled={running} onchange={(event) => changeAction(event.currentTarget.value as ImageAction)}>
              {#each IMAGE_ACTIONS as action (action)}
                <option value={action} disabled={!available(action)}>{actionLabel(action)}</option>
              {/each}
            </select>
          </label>
          {#if !canWriteDocuments && selectedAction !== "preview" && selectedAction !== "showPlayers"}
            <p class="warning">Players can preview only. Persistent scene, tile, token and journal changes are GM-only.</p>
          {/if}
          {#if restrictedPlayerMode && !canWriteDocuments}<p class="warning">The GM has enabled restricted player mode; persistent image actions are disabled.</p>{/if}
          {#if selectedAction === "showPlayers"}<p class="notice">This stores/updates your per-user shared-image slot, then publishes the image to connected players.</p>{/if}

          <label class="folder">Upload directory <span><input bind:value={folderDraft} maxlength="240" disabled={running} /><button type="button" disabled={running} onclick={() => { const folder = normalizeLogicalFolder(folderDraft); setPreferences({ defaultUploadFolder: folder, uploadFolderHistory: folder ? [folder, ...prefs.uploadFolderHistory.filter((item) => item !== folder)].slice(0, 10) : prefs.uploadFolderHistory }); }}>Use as default</button></span></label>
          <label>Recent directories
            <select value={folderDraft} disabled={running} onchange={(event) => folderSelected(event.currentTarget.value)}>
              {#each prefs.uploadFolderHistory as folder (folder)}<option value={folder}>{folder}</option>{/each}
            </select>
          </label>
          {#if isUrl && urlMode === "store"}<p class="hint">Store mode contacts this HTTPS host from your browser; the source URL is not saved by default.</p>{/if}

          {#if selectedAction === "newScene" || selectedAction === "replaceBackground"}
            <fieldset class="geometry">
              <legend>{selectedAction === "newScene" ? "New scene size and grid" : "Background sizing and alignment"}</legend>
              <div class="row">
                <label>Width<input type="number" min="1" max="100000" step="1" value={sceneWidth} disabled={running} oninput={(event) => changeWidth(Number(event.currentTarget.value))} /></label>
                <label>Height<input type="number" min="1" max="100000" step="1" value={sceneHeight} disabled={running} oninput={(event) => changeHeight(Number(event.currentTarget.value))} /></label>
              </div>
              <div class="row tight">
                <label class="check"><input type="checkbox" bind:checked={dimensionsLock} disabled={running} /> Lock image aspect ratio</label>
                <button type="button" disabled={running || !prepared} onclick={() => resetGeometry()}>Reset to image size</button>
              </div>
              {#if selectedAction === "replaceBackground" && scene && (scene.width !== sceneWidth || scene.height !== sceneHeight)}
                <label>Existing placeables when dimensions change
                  <select bind:value={resizeChoice} disabled={running}><option value="keep">Keep positions (default)</option><option value="rescale">Rescale placeables to new dimensions</option></select>
                </label>
                {#if resizeChoice === "rescale"}<p class="warning">Rescales token/tile/light/sound/wall/drawing/note/region coordinates as one undo step. Circular radii use the geometric-mean scale; normalized region shapes stay normalized.</p>{/if}
              {/if}
              <div class="row">
                <label>Grid type
                  <select bind:value={gridType} disabled={running}><option value="square">Square</option><option value="hex">Hex</option><option value="gridless">Gridless</option></select>
                </label>
                <label>Grid size (px)
                  <input type="number" min="50" max="1000" step="1" bind:value={gridSize} disabled={running || gridType === "gridless"} />
                </label>
              </div>
              <div class="suggestions">{#each [70, 100, 140, 200] as size (size)}<button type="button" disabled={running || gridType === "gridless"} onclick={() => (gridSize = size)}>{size}</button>{/each}</div>
              <div class="row grid-from">
                <label>Squares across<input type="number" min="1" step="1" bind:value={squareColumns} disabled={running} /></label>
                <button type="button" disabled={running || !prepared} onclick={suggestGrid}>Grid from image</button>
              </div>
              {#if gridWarning}<p class="hint">{gridWarning}</p>{/if}
              <div class="row">
                <label>Background offset X (px)<input type="number" step="1" bind:value={offsetX} disabled={running} /></label>
                <label>Background offset Y (px)<input type="number" step="1" bind:value={offsetY} disabled={running} /></label>
              </div>
              <div class="row">
                <label>Background scale<input type="number" min="0.1" max="10" step="0.05" bind:value={backgroundScale} disabled={running} /></label>
                <label>Padding (%)<input type="number" min="0" max="100" step="1" value={padding * 100} disabled={running} oninput={(event) => (padding = Math.max(0, Math.min(1, Number(event.currentTarget.value) / 100)))} /></label>
              </div>
              <label>Background colour <span class="color"><input type="color" bind:value={backgroundColor} disabled={running} /><input value={backgroundColor} pattern="#[0-9a-fA-F]{6}" maxlength="7" disabled={running} oninput={(event) => { if (/^#[0-9a-f]{6}$/i.test(event.currentTarget.value)) backgroundColor = event.currentTarget.value; }} /></span></label>
              <button type="button" class="align-toggle" aria-expanded={alignmentOpen} onclick={() => (alignmentOpen = !alignmentOpen)}>{alignmentOpen ? "Hide" : "Show"} grid alignment preview</button>
              {#if alignmentOpen && prepared}
                <div class="alignment-preview" style={`width:${previewWidth}px;height:${previewHeight}px`}>
                  {#if isVideoMime(prepared.mime)}
                    <video src={prepared.previewUrl} muted loop autoplay playsinline aria-label="Map with grid alignment preview" style={`width:${prepared.width * backgroundScale * previewScale}px;height:${prepared.height * backgroundScale * previewScale}px;left:${offsetX * previewScale}px;top:${offsetY * previewScale}px`}></video>
                  {:else}
                  <img src={prepared.previewUrl} alt="Map with grid alignment preview" style={`width:${prepared.width * backgroundScale * previewScale}px;height:${prepared.height * backgroundScale * previewScale}px;left:${offsetX * previewScale}px;top:${offsetY * previewScale}px`} />
                  {/if}
                  {#if gridType === "square"}<div class="grid-overlay" style={`background-size:${previewGridSize}px ${previewGridSize}px`}></div>{/if}
                </div>
              {/if}
            </fieldset>
          {/if}

          {#if selectedAction === "tileGrid"}
            <label>Asset Grid Size (pixels per image square)
              <input type="number" min="50" step="1" bind:value={assetGridSize} disabled={running} />
            </label>
          {/if}
          {#if selectedAction === "replaceForeground" && scene && prepared}
            {#if Math.abs(prepared.width / prepared.height - scene.width / scene.height) > 0.01}<p class="warning">The foreground aspect ratio differs from the scene. The image will be stretched to {scene.width} × {scene.height} px.</p>{/if}
            <label>Foreground elevation<input type="number" step="1" bind:value={foregroundElevation} disabled={running} /></label>
          {/if}
          {#if selectedAction !== "showPlayers"}
            <label class="check share"><input type="checkbox" checked={shareAfter} disabled={running || !canShare || (restrictedPlayerMode && !canWriteDocuments)} onchange={(event) => { shareAfter = event.currentTarget.checked; setPreferences({ defaultShareToPlayers: shareAfter }); }} /> Also share stored image with players</label>
          {/if}
          {#if prefs.webpConvert}<p class="hint">Stored original will be converted to WebP at quality {prefs.webpQuality.toFixed(2)}; derivatives remain WebP.</p>{:else}<p class="hint">Original format is preserved. Thumbnail/mid-res and large-map tiles are generated separately.</p>{/if}
        {/if}
      </div>
    </div>

    {#if progress}<p class="progress" role="status">{progress}</p>{/if}
    <footer>
      <span class="status">{#if running}Working…{:else if loading}Validating source…{:else if sources.length > 1}{currentIndex + 1} of {sources.length} images{:else}Source validated{/if}</span>
      <button type="button" disabled={running} onclick={cancel}>Cancel</button>
      <button type="button" class="primary" disabled={running || loading || !prepared || !actionAllowed} onclick={() => processBatch(false)}>{selectedAction === "preview" && !shareAfter ? "Close preview" : "Apply to image"}</button>
      {#if sources.length > 1}<button type="button" class="primary" disabled={running || loading || !prepared || !actionAllowed} onclick={() => processBatch(true)}>{selectedAction === "preview" && !shareAfter ? `Preview ${sources.length} images` : `Apply to all ${sources.length}`}</button>{/if}
    </footer>
  </div>
</div>

<style>
  .backdrop { position:fixed; inset:0; z-index:5000; display:grid; place-items:center; padding:16px; background:#080b10cc; }
  .dialog { display:flex; flex-direction:column; min-width:420px; min-height:420px; max-width:min(96vw,1600px); max-height:94vh; resize:both; overflow:hidden; color:#e2e8f0; background:#171c23; border:1px solid #44505f; border-radius:10px; box-shadow:0 18px 70px #000b; }
  .dialog-head { display:flex; align-items:flex-start; justify-content:space-between; gap:10px; padding:12px 15px; border-bottom:1px solid #303944; }
  h2 { margin:0; font-size:16px; } .eyebrow { margin:0 0 4px; font-size:9px; letter-spacing:.12em; color:#8da0b4; }
  .close { width:30px; height:30px; border:1px solid #424c59; border-radius:5px; background:#20262e; color:#dce4ee; font-size:20px; cursor:pointer; }
  .dialog-body { display:grid; grid-template-columns:minmax(190px, .85fr) minmax(250px,1.15fr); gap:13px; overflow:auto; padding:12px; flex:1; }
  .preview-column,.form-column { display:flex; flex-direction:column; gap:7px; min-width:0; }
  .preview-frame { min-height:170px; max-height:320px; display:grid; place-items:center; background:#0d1117; border:1px solid #35414e; border-radius:6px; overflow:hidden; }
  .preview-frame img { display:block; max-width:100%; max-height:320px; object-fit:contain; }
  .metadata,.hint { margin:0; font-size:10px; color:#98a5b5; overflow-wrap:anywhere; }
  .notice,.warning,.error { margin:2px 0; padding:7px; border-radius:5px; font-size:11px; line-height:1.35; }
  .notice { color:#cce9ff; background:#182b3a; border:1px solid #335c76; }
  .warning { color:#f0dfad; background:#2e291a; border:1px solid #665b3d; }
  .error { color:#ffc5ba; background:#331e1d; border:1px solid #80443e; }
  label { display:flex; flex-direction:column; gap:4px; font-size:11px; color:#bac5d3; }
  input:not([type=checkbox]):not([type=color]),select { min-width:0; padding:6px 7px; color:#e5ebf4; background:#10151b; border:1px solid #3b4653; border-radius:4px; }
  input[type=checkbox] { accent-color:#56ad9d; }
  .row { display:grid; grid-template-columns:1fr 1fr; gap:7px; }
  .tight { align-items:center; }
  .check { flex-direction:row; align-items:center; }
  .folder span,.color { display:flex; gap:5px; align-items:center; }
  .folder input { flex:1; }
  .color input[type=color] { width:40px; height:28px; padding:1px; border:1px solid #495564; background:#11161d; border-radius:4px; }
  .color input:not([type=color]) { width:90px; }
  .url-source { display:flex; flex-direction:column; gap:6px; padding:7px; background:#11171e; border:1px solid #37424e; border-radius:5px; }
  .url-source code { max-height:48px; overflow:auto; word-break:break-all; color:#abc7df; font-size:10px; }
  .geometry { display:flex; flex-direction:column; gap:7px; margin:0; padding:8px; border:1px solid #3a4552; border-radius:6px; }
  legend { padding:0 4px; color:#b8c9d9; font-size:11px; }
  .suggestions { display:flex; gap:5px; }
  .suggestions button,.align-toggle { padding:4px 7px; border:1px solid #3e4b59; border-radius:4px; color:#d6e2ef; background:#222a33; }
  .grid-from { align-items:end; }
  .grid-from button { min-height:29px; padding:5px; border:1px solid #3c7e73; border-radius:4px; color:#d7fff6; background:#183a34; }
  .alignment-preview { position:relative; max-width:100%; max-height:250px; overflow:hidden; align-self:flex-start; background:#e7e7e7; border:1px solid #697685; }
  .alignment-preview img { position:absolute; max-width:none; max-height:none; object-fit:fill; }
  .grid-overlay { position:absolute; inset:0; pointer-events:none; background-image:linear-gradient(to right, #1da1ff99 1px, transparent 1px),linear-gradient(to bottom, #1da1ff99 1px, transparent 1px); }
  .source-list { display:flex; flex-direction:column; gap:3px; max-height:200px; overflow:auto; }
  .source-list button { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; padding:4px 6px; border:1px solid #34404c; border-radius:4px; color:#b6c2d0; background:#1e252d; text-align:left; }
  .source-list button.current { color:#dffbf4; border-color:#438879; background:#1b332f; }
  .collision { display:flex; flex-wrap:wrap; gap:5px; padding:8px; border:1px solid #8d7543; border-radius:5px; background:#292417; font-size:11px; }
  .collision strong { width:100%; }
  .collision button { border:1px solid #675a3c; border-radius:4px; color:#f0dfad; background:#39311d; padding:4px 7px; }
  .share { margin-top:4px; }
  .progress { margin:0; padding:5px 12px; font-size:11px; color:#9ddccf; }
  footer { display:flex; align-items:center; justify-content:flex-end; flex-wrap:wrap; gap:6px; padding:10px 12px; border-top:1px solid #303944; }
  footer .status { flex:1; color:#a6b1be; font-size:11px; }
  footer button { padding:6px 9px; border:1px solid #3a4653; border-radius:5px; color:#dce4ed; background:#242b33; cursor:pointer; }
  footer button.primary { border-color:#3f8d81; background:#1a4039; color:#e2fff8; }
  button:disabled { opacity:.5; cursor:not-allowed; }
  @media (max-width:760px) { .dialog { width:96vw!important; height:94vh!important; } .dialog-body { grid-template-columns:1fr; } .preview-frame { min-height:130px; max-height:190px; } }
</style>
