/**
 * D-487: profile payloads for `ais.profile`. One WebRTC user message caps at 256 KiB; the
 * composed runtime-provider + guest source of a Foundry adapter module measures ≈312 KiB raw,
 * so heavy modules travel deflated (`payloadZ`) and small modules keep the plain fields.
 * The digest that binds consent (`deliveredDigest`) runs on the expanded form either way.
 */
import { deflateSync, Inflate } from "fflate";
import type { AisSharedModule } from "./messages";

const PACK_THRESHOLD = 32 * 1024;
/** Shared by sender/admission/inflater; frames are sharded by the transport below AIS. */
export const AIS_SHARED_COMPRESSED_BYTES = 8 * 1024 * 1024;
export const AIS_SHARED_EXPANDED_BYTES = 32 * 1024 * 1024;

function inflateBounded(payload: Uint8Array): Uint8Array {
  if (payload.byteLength > AIS_SHARED_COMPRESSED_BYTES) throw new Error("AIS shared payload exceeds compressed budget");
  const chunks: Uint8Array[] = [];
  let length = 0;
  const stream = new Inflate((chunk) => {
    length += chunk.byteLength;
    if (length > AIS_SHARED_EXPANDED_BYTES) throw new Error("AIS shared payload exceeds expanded budget");
    chunks.push(chunk);
  });
  // Bound temporary expansion as well as retained output. A tiny input slice cannot
  // make the inflater allocate the entire output of a compressed bomb in one push.
  for (let offset = 0; offset < payload.length; offset += 1024)
    stream.push(payload.subarray(offset, offset + 1024), offset + 1024 >= payload.length);
  if (!payload.length) stream.push(payload, true);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}

/** Heavy fields ({source, resources?, runtimeContext?}) of one shared module. */
type AisSharedModuleHeavy = Pick<AisSharedModule, "source" | "resources" | "runtimeContext">;

export function packAisSharedModule(module: AisSharedModule): AisSharedModule {
  const heavy: AisSharedModuleHeavy = {
    ...(module.source !== undefined ? { source: module.source } : {}),
    ...(module.resources !== undefined ? { resources: module.resources } : {}),
    ...(module.runtimeContext !== undefined ? { runtimeContext: module.runtimeContext } : {}),
  };
  const text = JSON.stringify(heavy);
  if (new TextEncoder().encode(text).byteLength > AIS_SHARED_EXPANDED_BYTES)
    throw new Error(`AIS shared module ${module.packageId} exceeds expanded budget`);
  if (text.length <= PACK_THRESHOLD) return module;
  const packed = deflateSync(new TextEncoder().encode(text), { level: 6 });
  if (packed.byteLength > AIS_SHARED_COMPRESSED_BYTES)
    throw new Error(`AIS shared module ${module.packageId} exceeds compressed budget`);
  return {
    packageId: module.packageId,
    name: module.name,
    version: module.version,
    hash: module.hash,
    commands: module.commands,
    capabilities: module.capabilities,
    emittedEvents: module.emittedEvents,
    ...(module.runtimeHash !== undefined ? { runtimeHash: module.runtimeHash } : {}),
    ...(module.tokenActions !== undefined ? { tokenActions: module.tokenActions } : {}),
    ...(module.panel !== undefined ? { panel: module.panel } : {}),
    ...(module.settings !== undefined ? { settings: module.settings } : {}),
    ...(module.requires !== undefined ? { requires: module.requires } : {}),
    ...(module.provides !== undefined ? { provides: module.provides } : {}),
    payloadZ: packed,
  };
}

/** The expanded form every runtime consumes (the source is always present). */
export type AisSharedModuleReady = AisSharedModule & { source: string };

export function expandAisSharedModule(module: AisSharedModule): AisSharedModuleReady {
  if (!module.payloadZ) {
    if (typeof module.source !== "string") throw new Error(`AIS shared module ${module.packageId} carries no source`);
    return { ...module, source: module.source };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(inflateBounded(module.payloadZ)));
  } catch (cause) {
    throw new Error(`AIS shared module ${module.packageId} payload does not inflate`, { cause });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`AIS shared module ${module.packageId} payload is not an object`);
  const heavy = parsed as AisSharedModuleHeavy;
  if (typeof heavy.source !== "string") throw new Error(`AIS shared module ${module.packageId} payload carries no source`);
  // `payloadZ` may stay on the expanded object; consumers read the expanded fields only.
  return {
    ...module,
    source: heavy.source,
    ...(heavy.resources !== undefined ? { resources: heavy.resources } : {}),
    ...(heavy.runtimeContext !== undefined ? { runtimeContext: heavy.runtimeContext } : {}),
  };
}
