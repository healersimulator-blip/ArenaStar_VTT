/**
 * §4/§10 folders — pure tree helpers over FolderDocument (typed target
 * collections, nesting, cycle-safe moves).
 */
import type { CollectionName, FolderDocument } from "./documents";

export interface FolderNode {
  folder: FolderDocument;
  children: FolderNode[];
  depth: number;
}

/** Build the nesting forest (roots have parent === null), depth-first order. */
export function buildFolderTree(folders: readonly FolderDocument[]): FolderNode[] {
  const byId = new Map<string, FolderNode>();
  for (const f of folders) byId.set(f._id, { folder: f, children: [], depth: 0 });
  const roots: FolderNode[] = [];
  for (const node of byId.values()) {
    const parent = node.folder.parent;
    const parentNode = parent ? byId.get(parent) : undefined;
    if (parentNode && parentNode !== node) parentNode.children.push(node);
    else roots.push(node); // null parent, missing parent, or self-parent
  }
  const assignDepth = (node: FolderNode, depth: number): void => {
    node.depth = depth;
    for (const child of node.children) assignDepth(child, depth + 1);
  };
  for (const root of roots) assignDepth(root, 0);
  return roots;
}

/** Flattened depth-first list (sidebar rendering order). */
export function flattenTree(nodes: readonly FolderNode[]): FolderNode[] {
  const out: FolderNode[] = [];
  const walk = (list: readonly FolderNode[]): void => {
    for (const n of list) {
      out.push(n);
      walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

/**
 * Would moving `folderId` under `newParentId` create a cycle?
 * (A folder cannot become its own ancestor; null parent is always fine.)
 */
export function wouldCycle(
  folders: readonly FolderDocument[],
  folderId: string,
  newParentId: string | null,
): boolean {
  if (newParentId === null) return false;
  if (folderId === newParentId) return true;
  const byId = new Map(folders.map((f) => [f._id, f] as const));
  let cursor = byId.get(newParentId);
  const seen = new Set<string>();
  while (cursor) {
    if (cursor._id === folderId) return true;
    if (seen.has(cursor._id)) return true; // pre-existing cycle in data
    seen.add(cursor._id);
    cursor = cursor.parent ? byId.get(cursor.parent) : undefined;
  }
  return false;
}

/** Full display path of a folder ("Root / Sub / Leaf"). */
export function folderPath(folders: readonly FolderDocument[], folderId: string): string {
  const byId = new Map(folders.map((f) => [f._id, f] as const));
  const parts: string[] = [];
  let cursor = byId.get(folderId);
  const seen = new Set<string>();
  while (cursor && !seen.has(cursor._id)) {
    seen.add(cursor._id);
    parts.unshift(cursor.name);
    cursor = cursor.parent ? byId.get(cursor.parent) : undefined;
  }
  return parts.join(" / ");
}

/** Folders that can contain `coll` docs, filtered by targetType (§4). */
export function foldersFor(
  folders: readonly FolderDocument[],
  coll: CollectionName,
): FolderDocument[] {
  return folders.filter((f) => f.targetType === coll);
}
