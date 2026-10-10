/**
 * Asset entitlements are the intersection of the manifest's publication policy
 * and a viewer's projected document MEDIA references. A hash is NOT an entitlement:
 * snapshot metadata, live manifest replacements and every streamed chunk use the
 * same predicate. Never recursively scan arbitrary strings (GM notes, chat,
 * code, tags or a system's unrelated data might happen to contain a hash).
 *
 * Legacy entries without visibility are world-readable only if no *known* private
 * document references them; new imports default to `referenced`. Old cached bytes
 * cannot be revoked. Packages adding custom media keys need an explicit registry.
 */
import {
  TOP_LEVEL_COLLECTIONS,
  type AssetManifest,
  type BaseDocument,
  type WorldCollections,
} from "./documents";
import type { PermissionUser } from "./ownership";
import { projectWorld } from "./projection";

const MEDIA_KEYS = new Set(["img", "src", "icon", "audio", "assetId", "packAsset"]);

function references(collections: Partial<WorldCollections>, manifest: AssetManifest): Set<string> {
  const found = new Set<string>();
  const add = (ref: unknown): void => {
    if (typeof ref === "string" && Object.prototype.hasOwnProperty.call(manifest, ref)) found.add(ref);
  };
  const visited = new WeakSet<object>();
  /** Custom PF1e/package `system` and core flags: only named media fields grant access. */
  const scanCustom = (value: unknown, depth = 0): void => {
    if (!value || typeof value !== "object" || depth > 8 || visited.has(value)) return;
    visited.add(value);
    if (Array.isArray(value)) {
      for (const child of value) scanCustom(child, depth + 1);
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      if (MEDIA_KEYS.has(key)) add(child);
      if (typeof child === "object") scanCustom(child, depth + 1);
    }
  };
  const custom = (doc: Partial<BaseDocument>): void => {
    scanCustom(doc.system);
    scanCustom(doc.flags?.core);
  };

  for (const coll of TOP_LEVEL_COLLECTIONS) {
    for (const doc of collections[coll] ?? []) custom(doc);
  }
  for (const scene of collections.scenes ?? []) {
    add(scene.img);
    add(scene.thumbnail);
    add(scene.foreground?.img);
    for (const token of scene.tokens ?? []) { add(token.img); custom(token); }
    for (const tile of scene.tiles ?? []) { add(tile.img); custom(tile); }
    for (const sound of scene.sounds ?? []) { add(sound.audio); custom(sound); }
    for (const note of scene.notes ?? []) { add(note.icon); custom(note); }
    for (const cell of scene.cells ?? []) {
      custom(cell);
      for (const feature of cell.features ?? []) add(feature.img);
    }
  }
  for (const actor of collections.actors ?? []) {
    for (const item of actor.items ?? []) custom(item);
  }
  for (const journal of collections.journals ?? []) {
    for (const page of journal.pages ?? []) { add(page.src); custom(page); }
    const codex = journal.codex as unknown;
    if (!codex || typeof codex !== "object" || Array.isArray(codex)) continue;
    const sheet = codex as Record<string, unknown>;
    add(sheet.cover);
    if (!Array.isArray(sheet.widgets)) continue;
    for (const rawWidget of sheet.widgets) {
      if (!rawWidget || typeof rawWidget !== "object" || Array.isArray(rawWidget)) continue;
      const widget = rawWidget as Record<string, unknown>;
      if (widget.type !== "image-gallery" || widget.version !== 1 ||
          !widget.config || typeof widget.config !== "object" || Array.isArray(widget.config)) continue;
      const config = widget.config as Record<string, unknown>;
      if (!Array.isArray(config.images)) continue;
      for (const image of config.images) {
        if (!image || typeof image !== "object" || Array.isArray(image)) continue;
        add((image as Record<string, unknown>).assetId);
      }
    }
  }
  for (const playlist of collections.playlists ?? []) {
    for (const sound of playlist.sounds ?? []) { add(sound.audio); custom(sound); }
  }
  for (const macro of collections.macros ?? []) {
    // A preset (D-310) is invisible to players, so counting its media as *referenced*
    // is also what withholds those bytes from a player's manifest: the preset is not in
    // their projected world, and the asset is not world-readable on its own.
    const sections = macro.kind === "sequence" ? macro.sequence?.sections
      : macro.kind === "fxPreset" ? macro.preset?.sections : undefined;
    if (!Array.isArray(sections)) continue;
    for (const section of sections) {
      if (section.kind === "image" || section.kind === "sound") add(section.assetId);
    }
  }
  // Saved graph media is a known private reference, not a loose legacy asset.
  // Graphs never project to players. Only the resulting visible scene/tile image
  // grants access after commit; undo removes that grant again.
  for (const graph of collections.automations ?? []) {
    if (!Array.isArray(graph.definition?.steps)) continue;
    for (const step of graph.definition.steps) {
      if (step?.kind === "sceneBackground" || step?.kind === "tileImage") add(step.image);
      if (step?.kind === "tileImage" && Array.isArray(step.images)) for (const image of step.images) add(image);
    }
  }
  for (const cards of collections.cards ?? []) {
    for (const card of cards.cards ?? []) add(card.img);
  }
  for (const pack of collections.compendia ?? []) add(pack.packAsset);

  // Derived thumbnails/mid resolutions/tiles inherit ONLY their source's entitlement.
  const queue = [...found];
  for (let i = 0; i < queue.length; i++) {
    const entry = manifest[queue[i] ?? ""];
    const derived = [entry?.thumb?.assetId, entry?.mid?.assetId, ...(entry?.tiles?.ids ?? [])];
    for (const hash of derived) {
      if (!hash || !manifest[hash] || found.has(hash)) continue;
      found.add(hash);
      queue.push(hash);
    }
  }
  return found;
}

/** Called against current host state, not an old cached snapshot. */
/** Media referenced by a selected projected document closure (used by Codex share bundles). */
export function projectWorldAssetReferences(
  collections: Partial<WorldCollections>,
  manifest: AssetManifest,
): Set<string> {
  return references(collections, manifest);
}

export function projectAssetManifest(
  world: Readonly<WorldCollections>,
  manifest: AssetManifest,
  viewer: PermissionUser,
): AssetManifest {
  if (viewer.role === "GM" || viewer.role === "ASSISTANT") return manifest;
  const full = references(world, manifest);
  // Host manifests may live in an asset service separate from WorldCollections. Project Codex
  // gallery IDs against the manifest actually being published, not a stale/empty cached field.
  const withManifest = { ...world, assetManifest: manifest } as WorldCollections;
  const visible = references(projectWorld(withManifest, 0, viewer).collections, manifest);
  const allowed: AssetManifest = {};
  for (const [hash, entry] of Object.entries(manifest)) {
    // Unclassified legacy assets with no known media reference retain their old
    // world policy. A known hidden-only reference is protected on old worlds.
    const policy = entry.visibility ?? (full.has(hash) ? "referenced" : "world");
    if (policy !== "gm" && (policy === "world" || visible.has(hash))) {
      // Import provenance and logical folder aliases are GM metadata, not player-facing asset data.
      const projected = { ...entry };
      delete projected.source;
      delete projected.logicalFiles;
      allowed[hash] = projected;
    }
  }
  return allowed;
}

export function canFetchAsset(
  world: Readonly<WorldCollections>,
  manifest: AssetManifest,
  viewer: PermissionUser,
  hash: string,
): boolean {
  return Object.prototype.hasOwnProperty.call(projectAssetManifest(world, manifest, viewer), hash);
}
