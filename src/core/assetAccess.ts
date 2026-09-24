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
  }
  for (const playlist of collections.playlists ?? []) {
    for (const sound of playlist.sounds ?? []) { add(sound.audio); custom(sound); }
  }
  for (const macro of collections.macros ?? []) {
    if (macro.kind !== "sequence" || !Array.isArray(macro.sequence?.sections)) continue;
    for (const section of macro.sequence.sections) {
      if (section.kind === "image" || section.kind === "sound") add(section.assetId);
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
export function projectAssetManifest(
  world: Readonly<WorldCollections>,
  manifest: AssetManifest,
  viewer: PermissionUser,
): AssetManifest {
  if (viewer.role === "GM" || viewer.role === "ASSISTANT") return manifest;
  const full = references(world, manifest);
  const visible = references(projectWorld(world as WorldCollections, 0, viewer).collections, manifest);
  const allowed: AssetManifest = {};
  for (const [hash, entry] of Object.entries(manifest)) {
    // Unclassified legacy assets with no known media reference retain their old
    // world policy. A known hidden-only reference is protected on old worlds.
    const policy = entry.visibility ?? (full.has(hash) ? "referenced" : "world");
    if (policy !== "gm" && (policy === "world" || visible.has(hash))) allowed[hash] = entry;
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
